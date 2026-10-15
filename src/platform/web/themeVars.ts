/**
 * 主题的运行时装载：唯一一处把调色板写进 DOM 的地方。
 *
 * 机制：CSS 自定义属性。54 条 --cm-* 变量一次写在 <html>（documentElement）上，
 * src/theme.ts 里导出的 colors / tokenColors / FILE_COLORS 全是 var(--cm-*) 引用，
 * 于是所有样式表、内联 style、SVG 的 fill 表现属性一起跟着变。
 *
 * 因此切换主题不需要 React 参与：不重渲染、不重新解析文件、代码高亮的分片不失效。
 * 浏览器重算样式是 O(受影响的绘制)，实测切换后 getComputedStyle 立刻是新的色值。
 *
 * 两处硬约束（详见 theme.ts 头注与 docs/adr/0004）：
 *   1. 色值必须以 var( 开头 —— react-native-web 的 isWebColor 不认 rgba(var(--x),.5)；
 *   2. CSP 的 script-src 只有 'self'，所以没有内联 boot script 可用，
 *      首帧靠入口模块作用域调 initTheme()（早于第一次绘制）。
 */
import { cssVarsFor, DEFAULT_THEME, THEMES, THEME_ORDER } from '../../theme';
import type { ThemeId } from '../../theme';

/** localStorage 键。只有这一个键，值只有 6 个合法取值，都不出本机。 */
export const THEME_PREF_KEY = 'code-map:theme';

function isThemeId(value: string): value is ThemeId {
  return (THEME_ORDER as readonly string[]).includes(value);
}

/** 当前主题的全部变量。纯函数，jest 无 DOM 也能拿到 54 条。 */
export function varsForTheme(themeId: ThemeId): Record<string, string> {
  return cssVarsFor(THEMES[themeId] ?? THEMES[DEFAULT_THEME]);
}

/**
 * 把一套主题写进 <html>：54 条变量 + style.colorScheme。
 * colorScheme 管的是浏览器原生件（滚动条、表单控件、光标）的明暗，不写的话亮色主题
 * 下滚动条还是深色。
 * 没有 document（SSR / 纯 node 测试）时静默返回：本模块的所有调用点都在浏览器侧。
 */
export function applyPalette(themeId: ThemeId): void {
  if (typeof document === 'undefined') return;
  const palette = THEMES[themeId] ?? THEMES[DEFAULT_THEME];
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(varsForTheme(themeId))) {
    style.setProperty(name, value);
  }
  style.colorScheme = palette.scheme;
}

/**
 * 改浏览器地址栏 / 标签页的 theme-color。
 * 只改已有 meta 的 content —— 那枚 meta 由 scripts/inject-html-head.mjs 在构建时注入，
 * 运行时新建一个会多出第二条，且 dev（npm run web）里凭空长出标签也谈不上同源。
 */
export function setThemeColorMeta(themeId: ThemeId): void {
  if (typeof document === 'undefined') return;
  const palette = THEMES[themeId] ?? THEMES[DEFAULT_THEME];
  for (const el of Array.from(document.getElementsByTagName('meta'))) {
    if (el.getAttribute('name') === 'theme-color') el.setAttribute('content', palette.colors.bg);
  }
}

/** 读偏好。非法值、缺键、存储被禁（隐私模式）—— 一律回落默认深色。 */
export function readThemePref(): ThemeId {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME;
    const raw = localStorage.getItem(THEME_PREF_KEY);
    if (raw && isThemeId(raw)) return raw;
  } catch {
    // localStorage 在部分浏览器策略下连读取都会抛异常：偏好是锦上添花，不该炸掉首屏
  }
  return DEFAULT_THEME;
}

/** 写偏好。写失败（配额 / 隐私模式）只意味着下次进来回到默认，不该打断当前这次切换。 */
export function writeThemePref(themeId: ThemeId): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THEME_PREF_KEY, themeId);
  } catch {
    // 同上：静默降级
  }
}

/**
 * 首帧装载：读偏好 -> 写变量 -> 同步 meta。在 app/_layout.tsx 的模块作用域调用，
 * 早于任何组件渲染，所以不会先闪一下默认深色再变成用户选的主题。
 */
export function initTheme(): ThemeId {
  const themeId = readThemePref();
  applyPalette(themeId);
  setThemeColorMeta(themeId);
  return themeId;
}
