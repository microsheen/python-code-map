/**
 * 拉取的 URL 分流与请求推导（issue #4 · ADR-0006 决策 1）。
 *
 * 纯函数：不发请求、不碰 DOM、不读时钟。用户粘进来的每一行都先过这里，
 * 只有拿到 kind === 'direct' 的结论才允许往下走成一次请求 —— 「非法 URL 不发请求」
 * 这条验收标准是靠这个顺序成立的，不是靠传输层再判一次。
 *
 * 非法结论带 reason 与 message 两样：reason 给代码分支（也是单测的断言点），
 * message 直接给用户看，所以是英文（仓库口径：中文文档 / 英文 UI 字符串）。
 * 五条文案必须互不相同 —— 「错误分类可区分」这条验收标准说的就是用户能不能一眼看出该改哪儿，
 * 笼统一句「无效的 URL」等于没分类。
 */

/** 只认路径以 .py/.pyi 结尾的直链；query/hash 不参与判断（?raw=1、#L10 都是常见写法）。 */
const PY_PATH_RE = /\.(py|pyi)$/i;

export type InvalidUrlReason =
  'empty' | 'not-a-url' | 'insecure' | 'unsupported-scheme' | 'not-python';

export type PullTriage =
  { kind: 'direct'; url: string } | { kind: 'invalid'; reason: InvalidUrlReason; message: string };

/**
 * 一次拉取请求的全部输入。
 *
 * 这里**故意没有** method / body / headers 三个字段：承诺是「拉取只发出对用户所给 URL 的 GET、
 * 请求体恒空」（ADR-0006 窄事实），把它做成类型上没有的位置，比在每个调用点检查一遍靠谱 ——
 * 传输层的接口也因此只有 get()，写不出 POST。冒烟 P 组再从真浏览器的网络记录上验一次。
 */
export interface PullRequest {
  url: string;
  /** 单请求超时；整批没有总超时，逐文件独立成败 */
  timeoutMs: number;
}

/** 单个请求的超时上限（issue #2 实现决策：单 fetch 15s）。 */
export const PULL_TIMEOUT_MS = 15000;

/** 回填进文案里的用户输入截断到这个长度：够认出来，不至于把一行错误撑满屏。 */
const ECHO_MAX = 60;

function echo(text: string): string {
  const t = text.trim();
  return t.length > ECHO_MAX ? t.slice(0, ECHO_MAX) + '…' : t;
}

function invalid(reason: InvalidUrlReason, message: string): PullTriage {
  return { kind: 'invalid', reason, message };
}

/**
 * 真正会发出去的那个 URL：origin + pathname + search，**不含 hash**。
 *
 * 片段（#L10）是浏览器侧的东西，服务端永远收不到，所以它既不该出现在请求里，也不该参与
 * 批次身份 —— 否则同一条直链只差一个 #L3 就会被当成两个批次，「重复粘贴同一 URL 原位更新」
 * 那条验收标准就漏了。query 相反：?raw=1 会改变服务端返回什么，必须保留。
 */
function wireUrl(u: URL): string {
  return u.origin + u.pathname + u.search;
}

/** 分流一条用户输入的 URL。 */
export function classifyUrl(raw: string): PullTriage {
  const text = (raw ?? '').trim();
  if (!text) {
    return invalid(
      'empty',
      'Nothing pasted: add one https:// link per line, each ending in .py or .pyi'
    );
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return invalid('not-a-url', `Not a URL: "${echo(text)}" — expected https://…/file.py`);
  }
  if (u.protocol === 'http:') {
    return invalid(
      'insecure',
      'http:// is blocked as mixed content by the browser — use the https:// version of this link'
    );
  }
  if (u.protocol !== 'https:') {
    return invalid(
      'unsupported-scheme',
      `Unsupported protocol "${u.protocol}" — only https:// links can be pulled`
    );
  }
  if (!PY_PATH_RE.test(u.pathname)) {
    return invalid(
      'not-python',
      `Not a Python file: the path must end in .py or .pyi (got "${echo(u.pathname)}")`
    );
  }
  return { kind: 'direct', url: wireUrl(u) };
}

/** 由一条已判定为 direct 的 URL 推导请求。纯函数，不再做校验（校验都在 classifyUrl）。 */
export function directRequest(url: string): PullRequest {
  return { url, timeoutMs: PULL_TIMEOUT_MS };
}

/**
 * 拉取文件在会话里的路径（身份）。
 *
 * 规则：host + URL 路径（去掉开头的 '/'），query 不参与。带上 host 是为了让不同来源的同名文件
 * 不互相覆盖（用户故事 8），也让拉取文件与本地文件天然不同名 —— 本地文件的路径来自
 * webkitRelativePath，不会带主机名。#5 会把 github.com 的页面 URL 映射成 owner/repo/ 前缀，
 * 那是**另一条分流**的规则，不影响这里：直链永远按 host + 路径落。
 *
 * 百分号编码原样保留、不解码：解码会让 `a.py%2Fb` 与 `a.py/b` 撞成同一个身份，
 * 而编码后的路径已经能唯一确定来源。
 */
export function pulledPathFor(url: string): string {
  const u = new URL(url);
  // pathname 本来就带开头的 '/'，它就是 host 与路径之间的那个分隔符，别再剥掉
  return u.host + u.pathname;
}

/**
 * 把粘贴框里的整段文本切成「一行一个 URL」。
 *
 * 只切分，不判定：不像 URL 的行原样交出去，由 classifyUrl 给出理由与文案 ——
 * 切分器替它做主（比如悄悄丢掉不认识的行）会让用户以为那行被拉过了。
 * 一次粘贴 N 行 = N 个批次，逐批独立成败（issue #2 批次模型）。
 */
export function splitPastedUrls(text: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
