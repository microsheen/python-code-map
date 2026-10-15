/**
 * 反馈通道的规则层：纯模块、零框架 import —— jest、Node 脚本与
 * scripts/audit-egress.mjs（逐字读源码，**注释也算**）都能直接吃它。
 *
 * 移植自 Event_Logger 的 src/utils/contact.js，形状保持一致，改成 TS 并换成
 * 本仓的白名单字段。两条渠道在这里都只是拼字符串：产出一个 href 而已。
 * 页面自己不发起任何请求 —— 用户不点，就什么都不会发生。这是「浏览器是唯一
 * 运行环境、服务器永不写用户数据」那两条承诺在反馈这件事上不被破掉的全部依据。
 *
 * 诊断字段是**白名单**而不是黑名单：收数组、只吐计数，于是文件名、函数名、
 * 代码原文在结构上就进不了输出（金丝雀断言见 __tests__/feedback.test.tsx）。
 */

/**
 * 私密渠道的对外地址。null = 门控关闭：面板不渲染地址块与邮件链接，
 * mailtoUrl 直接返回 null。启用步骤（含「真发一封测试信确认到达」）见
 * docs/ops-deployment.md 第 9 节；启用时的改动必须与 package.json 里的
 * --public-address= 在**同一个提交**里发生。
 */
export const CONTACT_EMAIL: string | null = null;

/** 公开渠道，也是主渠道：可跟进、有线程、别人能看到同一个问题的其它报告。 */
export const REPO_ISSUES_URL = 'https://github.com/microsheen/python-code-map/issues/new';

/** Issues 的标题 / 邮件的主题。诊断块绝不进标题 —— 标题会出现在列表、通知与搜索里。 */
export const ISSUE_TITLE = 'Feedback';
export const MAIL_SUBJECT = 'Python Code Map - feedback';

/** 顺序即输出顺序。改这个数组等于改契约：冒烟 G3/G4、金丝雀测试、README 都要同步改。 */
export const DIAG_FIELD_NAMES = Object.freeze([
  'build',
  'ua',
  'files',
  'funcs',
  'edges',
  'unresolved',
  'warnings',
  'persisted',
] as const);

export type DiagFieldName = (typeof DIAG_FIELD_NAMES)[number];
export type DiagValue = string | number;
export type DiagFields = Record<DiagFieldName, DiagValue>;

/** 调用方可以给的东西：全部 unknown，收口由本模块负责，绝不相信上游。 */
export interface DiagSource {
  build?: unknown;
  buildId?: unknown;
  ua?: unknown;
  userAgent?: unknown;
  files?: unknown;
  funcs?: unknown;
  edges?: unknown;
  unresolved?: unknown;
  warnings?: unknown;
  persisted?: unknown;
}

/** 诊断块总长预算：邮件正文与 Issue 正文都带同一份，超出预算只牺牲 ua 的尾巴。 */
export const DIAG_MAX_CHARS = 600;
const UA_MAX_CHARS = 160;
const SCALAR_MAX_CHARS = 64;

/**
 * 换行与控制字符一律剥掉：诊断块是逐行 key=value 的格式，混进一个换行就会
 * 伪造出「多一行字段」，混进 NUL 会让收件方的解析器瞎掉。
 * 刻意不用控制字符正则字面量（eslint 的 no-control-regex 会响），按码点走。
 */
function collapseControls(raw: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09) {
      // 换行/回车/制表符折成一个空格，连续的折成一个
      if (out.length > 0 && !pendingSpace) out += ' ';
      pendingSpace = true;
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue; // 其余 C0 与 DEL：直接丢
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function firstDefined(a: unknown, b: unknown): unknown {
  return a === undefined || a === null || a === '' ? b : a;
}

function toText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const clean = collapseControls(raw).trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/**
 * 数组取长度、有限数字取整，**其它一切退化为 0**。
 * 绝不 String(x)：那样会把调用方塞进来的任何东西原样搬进对外文本里。
 * 同时这也让 collectDiagnostics 是幂等的（上一轮输出的数字再喂一遍不会归零）。
 */
function toCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw >= 0 ? Math.floor(raw) : 0;
  return 0;
}

/**
 * 是/否三态。true 与 'yes' → yes，false 与 'no' → no，**其余一律 unknown**。
 * 不做强制转换：'true'（字符串）这种脏值如果悄悄变成 yes，就再也看不见调用方写错了。
 */
function toYesNo(raw: unknown): DiagValue {
  if (raw === true || raw === 'yes') return 'yes';
  if (raw === false || raw === 'no') return 'no';
  return 'unknown';
}

/**
 * 唯一出口：任何来源（数组 / 布尔 / 字符串 / 脏值 / null）都归一成「恰好这 8 个字段、
 * 值全是标量」。也接受上一轮的输出（buildId/build、userAgent/ua 两种拼写都认），
 * 所以渲染路径上拿旧文本再算一遍不会把已经收口的值退化成 unknown。
 */
export function collectDiagnostics(source?: DiagSource | DiagFields | null): DiagFields {
  const input = (source && typeof source === 'object' ? source : {}) as DiagSource;
  const bag = {} as Record<DiagFieldName, DiagValue>;
  DIAG_FIELD_NAMES.forEach((name) => {
    bag[name] = 'unknown';
  });
  bag.build = toText(firstDefined(input.buildId, input.build), SCALAR_MAX_CHARS) || 'unknown';
  bag.ua = toText(firstDefined(input.userAgent, input.ua), UA_MAX_CHARS) || 'unknown';
  bag.files = toCount(input.files);
  bag.funcs = toCount(input.funcs);
  bag.edges = toCount(input.edges);
  bag.unresolved = toCount(input.unresolved);
  bag.warnings = toCount(input.warnings);
  bag.persisted = toYesNo(input.persisted);
  return bag;
}

/**
 * 语言无关的 ASCII 诊断文本：Issues 与邮件带同一份，你用任何语言读反馈都能一眼对齐版本，
 * 脚本也能无猜测地解析。超预算时只截 ua 的尾巴（它是唯一可能超长的字段），
 * 绝不整行丢弃 —— 少一个字段比短一点的 ua 严重得多。
 *
 * maxChars 是第二个参数而不是只读 DIAG_MAX_CHARS：按现在的每字段上限
 * （ua 160、build 64）总长最多约 300，这道预算守卫在正常调用下永远走不到 ——
 * 它是给「以后有人把 ua 或字段上限调大」留的下限。一个走不到的分支等于没被验证过的
 * 分支，所以预算做成可注入的：测试用小预算把这条路径打亮，生产调用不传第二个参数。
 */
export function buildDiagnosticsText(
  source?: DiagSource | DiagFields | null,
  maxChars: number = DIAG_MAX_CHARS
): string {
  const fields = collectDiagnostics(source);
  const line = (name: DiagFieldName) => name + '=' + String(fields[name]);
  const lines = DIAG_FIELD_NAMES.map(line);
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  const uaLine = lines[DIAG_FIELD_NAMES.indexOf('ua')] ?? 'ua=unknown';
  const others = text.length - uaLine.length;
  // 6 = 'ua=' 前缀 + '...' 后缀
  const keep = Math.max(0, maxChars - others - 6);
  const trimmed = 'ua=' + String(fields.ua).slice(0, keep) + '...';
  return DIAG_FIELD_NAMES.map((name) => (name === 'ua' ? trimmed : line(name))).join('\n');
}

/** 正文模板：① 留白给用户写 ② 一句「只有计数、可随意改删」③ 诊断块置底。全 ASCII。 */
export function reportBody(diagText: string): string {
  return [
    'What happened? (write here - the report is yours)',
    '',
    '',
    'Diagnostics below are counts only: no file names, no function names, no code.',
    'Edit or delete anything you like - the link carries exactly what is in the block.',
    '',
    diagText,
  ].join('\n');
}

function encode(value: unknown): string {
  // encodeURIComponent 把空格编成 %20（不是 +）：mailto 与 GitHub 都只认前者
  return encodeURIComponent(value === null || value === undefined ? '' : String(value));
}

/** 公开渠道的 href。 */
export function issuesUrl(title: string, body: string): string {
  return REPO_ISSUES_URL + '?title=' + encode(title) + '&body=' + encode(body);
}

/** 私密渠道的 href；门控关闭时返回 null —— 这就是整条邮件路径的唯一开关。 */
export function mailtoUrl(subject: string, body: string): string | null {
  if (CONTACT_EMAIL === null) return null;
  return 'mailto:' + CONTACT_EMAIL + '?subject=' + encode(subject) + '&body=' + encode(body);
}

export function issuesHrefFor(diagText: string): string {
  return issuesUrl(ISSUE_TITLE, reportBody(diagText));
}

export function mailHrefFor(diagText: string): string | null {
  return mailtoUrl(MAIL_SUBJECT, reportBody(diagText));
}
