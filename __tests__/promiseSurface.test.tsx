/**
 * 承诺面契约：撤回了什么、保留了什么（ADR-0006 · issue #3）。
 *
 * 这一轮只改口径不改行为：README 三语不再宣称「零外发 / 每个请求都同源」，换成
 * local-first + 仅显式拉取才发请求；能被证明的窄事实（拉取只发出对用户所给 URL 的 GET、
 * 请求体恒空、代码内容从不被发往任何地方）原样保留；CSP 的 connect-src 从 'self'
 * 放开到 'self' https:（理由不在这里重述：源头是 ADR-0006 决策 2，完整版写在 public/_headers 注释里）。
 *
 * 为什么这些断言长成文本匹配的样子：口径是对外承诺，承诺最怕的不是写错，是**被改回来
 * 而没人发现**。同仓先例是 audit-egress.mjs（逐字扫，注释也算）与 feedback.test.tsx 的
 * 反向不变量（mailto: 只可能长在一个文件里）。
 *
 * 关于文件名：「承诺面」这个词本身没有被废 —— issue #3 的标题就叫「承诺面改口径」，
 * ADR-0006 通篇在用，本文件测的正是承诺面。被撤回的是那一档**全称宣称**，被改名的是
 * README 里 E 组那一行的**旧标签**。所以文件叫 promiseSurface、而 retracted 列表里禁
 * README 出现 "promise surface"，两件事不矛盾。
 *
 * 两半的性质不同，别混着改：
 *   - retracted 是**反向不变量**：这些字面永不再出现，出现即回归。这一半不该 churn。
 *   - retained 是**故意的文案锁**：AC 要求「保留窄事实」与「三语口径一致」，而窄事实是散文，
 *     除了字面锚点没有第二种断言方式。代价是有意改写文案时必须一并改这里的锚点 ——
 *     那种红灯是提醒，不是故障。别为了让它变绿就把锚点删掉。
 *     锁的**边界**同样要划：锚点只钉「三条窄事实 + 两档标签」这五个字面。风格性的句子、ADR 链接
 *     这类**不是承诺本身**的东西不进列表 —— 链接被删是文档问题，而锚点越多，有意改一次文案就要
 *     连带改越多地方，锁会退化成噪声（review 提过，采纳）。
 *
 * 已知边界：文本匹配抓得住「旧宣称复活」与「窄事实被顺手删掉」，抓不住换个说法重新吹一遍
 * 全称宣称 —— 那一档靠 review 与 ADR-0006。
 *
 * 三个接缝：
 *   1. public/_headers           —— 上线响应头唯一的源（dist/ 只是它的拷贝，且被 gitignore）
 *   2. <UploadPanel/>            —— 用户真正读到的那句提示
 *   3. README 三语 + browser-verify 的 E 组标签 —— 对外口径与门禁自己的措辞
 *      （E1–E5 基线 / E6–E8 承诺，两档都得在：只写一档就等于把另一档说没了）
 * 漏什么：Pages 边缘实际下发了什么。那是部署后 check-deploy 探针的事，本票不发布。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { UploadPanel } from '../src/components/UploadPanel';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

afterEach(cleanup);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** 通配段里那条 Content-Security-Policy 的原文行。读不到就抛 —— 静默跳过的守卫比红灯更糟。 */
function cspLine(): string {
  const line = read('public/_headers')
    .split(/\r?\n/)
    .find((l) => /^\s*Content-Security-Policy:/.test(l));
  if (!line) throw new Error('public/_headers 里读不到 Content-Security-Policy 行');
  return line;
}

/** 同一条 CSP，按指令拆开：指令名 -> 值。 */
function declaredCsp(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cspLine().replace(/^\s*Content-Security-Policy:\s*/, '').split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    const name = bits.shift();
    if (name) out[name] = bits.join(' ');
  }
  return out;
}

describe("public/_headers：connect-src 放开到协议粒度（ADR-0006 决策 2）", () => {
  const csp = declaredCsp();

  it("connect-src 恰好是 \"'self' https:\"", () => {
    expect(csp['connect-src']).toBe("'self' https:");
  });

  it('不写 http:（https 页面的混合内容本来就拦死），也没有偷懒退化成 *', () => {
    const v = csp['connect-src'] ?? '';
    expect(v).not.toMatch(/(^|\s)http:(\s|$)/);
    expect(v).not.toContain('*');
  });

  it("其余指令一条没动：default-src 仍是 'none'，script-src / form-action / frame-ancestors 照旧", () => {
    expect(csp['default-src']).toBe("'none'");
    expect(csp['script-src']).toBe("'self' 'wasm-unsafe-eval'");
    expect(csp['form-action']).toBe("'none'");
    expect(csp['frame-ancestors']).toBe("'none'");
  });

  it('CSP 里不写死任何主机名（任何「标签.TLD」形状都算，不枚举 TLD）：换域名时这个文件应当是零改动', () => {
    // 上一版枚举 com|dev|net|org|io，.cn/.app/.xyz 全漏；换成形状判断，新 TLD 不用改断言。
    expect(cspLine()).not.toMatch(/[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});

describe('上传面板提示：新口径，旧宣称零残留', () => {
  function panelText(): string {
    const { container } = render(<UploadPanel />);
    return container.textContent ?? '';
  }

  it('旧的全称宣称「Code never leaves the browser」已经不在了', () => {
    expect(panelText()).not.toContain('never leaves the browser');
  });

  it('窄事实还在：内容从不被发往任何地方', () => {
    expect(panelText()).toContain('never sent anywhere');
  });

  it('新口径两半都在：本地文件（拖拽）+ 只有显式拉取才发请求', () => {
    const text = panelText();
    expect(text).toContain('drag files anywhere on the page');
    expect(text).toContain('explicitly pull');
  });

  /**
   * 上一版标题写「整个 src/」，正则却只扫 /never leaves the browser/ —— 标题比断言宽，正是本轮
   * review 抓到的那种「门绿着、缺口在门的视野外」。FeedbackDialog 里那句
   * "nothing leaves the browser until you do" 是**限定式**的（外发以用户动作为条件），今天为真、
   * 也不属于被撤回的那一档，不该一刀切禁掉；该禁的是不带任何限定的同款说法。所以改成：扫全部
   * /leaves the browser/，要求每一处都带着用户动作限定。
   * 记账给 #9：拉取落地后 FeedbackDialog 那句「页面对外只有你点的 href」不再为真，要一并重写。
   */
  it('整个 src/ 里没有不带限定的「东西不会离开浏览器」式全称宣称', () => {
    const unqualified = sourceFiles(path.join(ROOT, 'src')).flatMap((f) =>
      (fs.readFileSync(f, 'utf8').match(/[^\n]*leaves the browser[^\n]*/gi) ?? [])
        .filter((line) => !/until you do/i.test(line))
        .map((line) => path.relative(ROOT, f).split(path.sep).join('/') + ': ' + line.trim()),
    );
    expect(unqualified).toEqual([]);
  });
});

/**
 * 三语口径。retracted 是被 ADR-0006 撤回的全称宣称与旧标签，一条都不许留；
 * retained 是必须还在的三条窄事实与两档标签，一条都不许顺手删掉（见文件头注：这是文案锁）。
 *
 * retracted 的第三类值得单说：反馈章节原先把「源码不上行」当成那条承诺的名字来引用。
 * 本轮已经把 ops §1 同一行改名成「代码内容不上行」，README 若不改就两处对不上 —— 而且
 * 这类「同一个旧词在别处还活着」的残留，正是只盖住自己刚改那几行的断言最容易漏的。
 *
 * retracted 的最后一类是**本轮自己犯过的错**：README 三语的 E 行原先整行贴上「默认行为基线」，
 * 把 E6–E8（入口 JS 就是产物那个文件 / URL 里没有用户内容 / 生产 CSP 下零违规）一起降了级 ——
 * 与 AC5「冒烟 E1–E5 措辞更新为默认行为基线」正相反，也与 CONTEXT.md、ops §1、CI 注释、
 * browser-verify.mjs 的标签全对不上。所以那三个旧行标签进 retracted：再出现即回归。
 */
const READMES = [
  {
    file: 'README.md',
    retracted: [
      'zero egress',
      'never leaves this machine as part of any request',
      'every request is same-origin',
      'promise surface',
      'promise-surface',
      'your source never goes upstream',
      '| E default-behaviour baseline |',
    ],
    retained: [
      'a GET to exactly the URL you typed',
      'every request body is empty',
      'your code contents are never sent anywhere',
      'E1–E5 are the default-behaviour baseline',
      'E6–E8 are promises',
    ],
  },
  {
    file: 'README.zh-CN.md',
    retracted: [
      '零上行',
      '不作为任何请求的一部分离开这台机器',
      '每个请求都是同源',
      '承诺面',
      '源码不上行',
      '| E 默认行为基线 |',
    ],
    retained: [
      '拉取只发出对你所给 URL 的 GET',
      '请求体恒空',
      '代码内容从不被发往任何地方',
      'E1–E5 是默认行为基线',
      'E6–E8 是承诺',
    ],
  },
  {
    file: 'README.ja.md',
    retracted: [
      '送信ゼロ',
      'いかなるリクエストの一部としてもこのマシンの外に出ません',
      'すべてのリクエストが同一オリジン、すべて GET',
      '約束の表面',
      'あなたのソースコードは上流に行かない',
      '| E 既定動作のベースライン |',
    ],
    retained: [
      'あなたが入力した URL への GET のみ',
      'リクエストボディは常に空',
      'コードの内容はどこにも送信されません',
      'E1–E5 は既定動作のベースライン',
      'E6–E8 は約束',
    ],
  },
];

describe.each(READMES)('$file：全称宣称已撤、窄事实保留', (spec) => {
  const text = read(spec.file);

  it.each(spec.retracted)('撤回的宣称零残留：%s', (phrase) => {
    expect(text).not.toContain(phrase);
  });

  it.each(spec.retained)('新口径与窄事实仍在：%s', (phrase) => {
    expect(text).toContain(phrase);
  });
});

describe('browser-verify：E1–E5 从「承诺证明」降级为「默认行为基线」', () => {
  const src = read('scripts/browser-verify.mjs');

  /**
   * 从脚本源码里把 check('E<n> …') 的标签抠出来。这里确实耦合了 browser-verify.mjs 的
   * 引号写法（换成双引号或模板串就会读不到），但读不到时它**抛**而不是静默跳过 ——
   * 静默跳过的守卫比红灯更糟，理由同仓 feedback.test.tsx 的 contactContract()。
   */
  function labelOf(id: string): string {
    const m = new RegExp("check\\(\\s*'(" + id + "[^']*)'").exec(src);
    if (!m || !m[1]) throw new Error('browser-verify.mjs 里找不到 ' + id + ' 的断言标签');
    return m[1];
  }

  it.each(['E1', 'E2', 'E3', 'E4', 'E5'])('%s 的标签带着「默认行为基线」这个限定', (id) => {
    expect(labelOf(id)).toContain('默认行为基线');
  });

  it('E1–E8 八个标签一个都没少（少一条 check() 会让 labelOf 抛；其余 67 条断言不在本文件视野里）', () => {
    for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']) {
      expect(labelOf(id).startsWith(id + ' ')).toBe(true);
    }
  });

  it('E7 / E8 仍然是承诺（内容不外发、生产 CSP 下零违规），没被一起降级掉', () => {
    expect(labelOf('E7')).toContain('URL 里没有用户内容');
    expect(labelOf('E8')).toContain('生产 CSP 下零违规');
  });
});
