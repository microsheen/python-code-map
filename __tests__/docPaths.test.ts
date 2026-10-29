import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 文档里写的仓库路径必须真的存在。
 *
 * 为什么值得一条门：这个错犯过两次，两次都靠人读出来。一次是 ops 与 log 把
 * `__tests__/promiseSurface.test.tsx` 写成 `.ts` —— 一条指向不存在文件的路径，在两份文档里；
 * 门禁全绿，因为它不在任何门的视野里。文档里的路径是**给下一个 agent 的导航指针**，
 * 指错一次，下一轮就要重新考古一遍。
 *
 * 抓得住：已提交文档（*.md、workflow 的 *.yml、public/_headers）里带目录段的仓库路径字面量，
 * 解析顺序是 仓库根 -> src/ -> public/（文档里常写 `feedback/contact.ts` 这种相对 src 的形式）。
 *
 * 抓不住，别指望它：
 *   - 不带目录段的裸文件名（`log.md`、`codemap-verify-report.json`）—— 无法区分「打错」与
 *     「运行时产物」，一律不查；
 *   - 目录段本身打错（锚点目录不存在时整条跳过，否则 React Native 内部的 `View/index.js`
 *     这类第三方路径会天天报假阳性）；
 *   - **专名**歧义（例如冒烟脚本的 F 组是图标链路、ADR-0006 的 F 组是拉取面）—— 那是语义冲突，
 *     不是路径问题，归 CODING_STANDARDS.md 管。
 *
 * 扫描用 `git ls-files -z` 而不是走目录树：只查**已提交**的文件，未入版本库的草稿不会把门弄红。
 */
const ROOT = path.resolve(__dirname, '..');
const EXT = 'tsx|ts|mts|cts|mjs|cjs|json|js|md|pyi|py|yaml|yml|svg|png|ico|html|css|wasm|txt';
/** 左边界挡住 `https://host/a/b.js` 与 `log.md/AGENTS.md` 这类连写；右边界挡住 `.tsx` 被读成 `.ts`。 */
const TOKEN = new RegExp('(?<![\\w.@/-])(?:[\\w.@-]+/)+[\\w.@-]+\\.(?:' + EXT + ')(?![\\w-])', 'g');
const DERIVED = /^(dist|node_modules|coverage|\.expo)\//;
const RESOLVE_ROOTS = ['', 'src/', 'public/'];

function committedDocs(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\0').filter((f) => /\.(md|yml|yaml)$/.test(f) || f === 'public/_headers');
}

function resolves(token: string): boolean {
  return RESOLVE_ROOTS.some((r) => fs.existsSync(path.join(ROOT, r + token)));
}

/** 锚点目录（第一段）在仓库里存在，这条路径才有「写错了」的可能。 */
function anchored(token: string): boolean {
  const first = token.slice(0, token.indexOf('/'));
  return RESOLVE_ROOTS.some((r) => {
    try {
      return fs.statSync(path.join(ROOT, r + first)).isDirectory();
    } catch {
      return false;
    }
  });
}

function scan(): { checked: number; dangling: string[] } {
  const dangling: string[] = [];
  let checked = 0;
  for (const rel of committedDocs()) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const token of text.match(TOKEN) ?? []) {
      if (DERIVED.test(token) || /[<>:*%…]|\.\.\./.test(token)) continue;
      if (!anchored(token)) continue;
      checked++;
      if (!resolves(token)) dangling.push(rel + ' -> ' + token);
    }
  }
  return { checked, dangling };
}

describe('已提交文档里的仓库路径', () => {
  const { checked, dangling } = scan();

  it('每条带目录段的路径字面量都指向真实存在的文件', () => {
    expect(dangling).toEqual([]);
  });

  /**
   * 抽取器本身也要被守住：正则一旦失配（比如改了扩展名清单），上面那条会**空转变绿** ——
   * 静默跳过的守卫比红灯更糟，理由同仓 feedback.test.tsx 的 contactContract()。
   * 245 是 2026-10-30 的实测值；文档只会变多，所以下限取一个宽裕的整数。
   */
  it('扫描器没有空转：本轮实际核对了 200 条以上路径字面量', () => {
    expect(checked).toBeGreaterThan(200);
  });
});