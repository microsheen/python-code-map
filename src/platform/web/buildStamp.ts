/**
 * 运行时取构建标识：从正在执行的入口脚本名 entry-&lt;hex&gt;.js 里取哈希的**前 8 位**。
 *
 * 为什么不写死一个常量：反馈要说的是「你看到的那批字节」，写死就把承诺换成了
 * 「发版时记得改」，而人会忘。取正在跑的这一个，就不可能说谎。
 *
 * 为什么只取 8 位：32 位十六进制串在公开仓库审计脚本里会被当成不透明 ID 报警
 * （docs/ops-deployment.md 第 4 节有这条戒）。8 位对齐版本足够，且不会撞上那条规则。
 *
 * dev（npm run web 的 Metro bundle）的脚本名不匹配这个形状，返回 unknown 是预期，
 * 不是故障 —— 门控值取不到时诚实说 unknown，比编一个号强。
 */

const ENTRY_RE = /\/entry-([0-9a-f]{8,})\.js/;

export function entryBuildStamp(): string {
  try {
    if (typeof document === 'undefined') return 'unknown';
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i += 1) {
      const el = scripts[i];
      const src = el && el.getAttribute ? el.getAttribute('src') : null;
      if (!src) continue;
      const m = ENTRY_RE.exec(src);
      if (m && m[1]) return m[1].slice(0, 8);
    }
  } catch {
    // 取不到就 unknown：诊断块少一个字段，永远不该在只读面板里抛异常
  }
  return 'unknown';
}
