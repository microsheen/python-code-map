/**
 * 主题调色板（6 套可切换）+ 度量常量。纯数据：不碰 DOM，应用与持久化在 src/platform/web/themeVars.ts。
 *
 * 界面颜色全部走 CSS 自定义属性。下面导出的 colors / tokenColors / FILE_COLORS 键名与形状和
 * 加主题之前完全一致，只是值变成了 var(--cm-*)：9 个组件文件加根布局一共 10 个模块在模块作用域
 * 消费这三张表，其中 7 个文件的 StyleSheet.create 一行不改就跟着主题走。切主题只需往 <html> 重写
 * 这 54 个变量（见 cssVarsFor），不触发 React 重渲染、不重新解析文件、代码高亮的 useMemo 分片也
 * 不失效。
 *
 * 变量名映射规则唯一，且由 __tests__/theme.test.ts 逐条钉住（引用了不存在的变量 = 静默失效）：
 *   colors.bg            -> --cm-bg
 *   colors.panelAlt      -> --cm-panel-alt      （camelCase 转 kebab-case）
 *   colors.onAccent      -> --cm-on-accent
 *   tokenColors.funcName -> --cm-tok-func-name
 *   fileColors[3]        -> --cm-file-3
 *
 * 硬约束：色值必须以 var( 开头。react-native-web 的 isWebColor 只放行 /^#hex|^rgb|^var\(/ 这类形状，
 * 写成 rgba(var(--x), .5) 会整条声明失效 —— 所以带透明度的颜色（overlay / *Soft / shadow / underline）
 * 必须整套定义成变量，而不是由不透明色拼透明度。
 *
 * 对比度门禁（WCAG 相对亮度）写在 __tests__/theme.test.ts：正文 4.5、图形与强调 3.0。
 * 每套主题取各自官方公开色表，过不了门禁的色值按同色相微调，不放宽门禁 —— 差异逐条标在主题块里。
 * 字体、字号、间距、圆角、布局尺寸、站点图标都不随主题变。
 */
import type { TokenScope } from './parser/types';

export type ThemeId =
  | 'github-dark'
  | 'github-light'
  | 'dracula'
  | 'nord'
  | 'solarized-dark'
  | 'solarized-light';

export type ColorScheme = 'dark' | 'light';

/** 31 个界面色位。新加颜色请同时加进调色板和变量表，别在组件里写字面色。 */
export interface ColorTokens {
  bg: string;
  paper: string;
  panel: string;
  panelAlt: string;
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accentDim: string;
  selected: string;
  selectedSoft: string;
  neighbor: string;
  danger: string;
  warn: string;
  ok: string;
  nodeFill: string;
  nodeFillExt: string;
  nodeStroke: string;
  edge: string;
  edgeDim: string;
  overlay: string;
  onAccent: string;
  tooltipBg: string;
  tooltipText: string;
  dangerSoft: string;
  warnSoft: string;
  shadow: string;
  underline: string;
}

export interface ThemePalette {
  id: ThemeId;
  /** 主题面板上显示的英文标签：配色官方名 */
  label: string;
  /** 写进 <html style="color-scheme">，管的是原生控件（滚动条、输入框光标、表单）的明暗 */
  scheme: ColorScheme;
  /** 字面色值：主题预览与 cssVarsFor 用它；界面引用的是下面的 var() 版本 */
  colors: ColorTokens;
  tokenColors: Record<TokenScope, string>;
  /** 按文件着色的 10 色环 */
  fileColors: readonly string[];
}

const PALETTES: Record<ThemeId, ThemePalette> = {
  'github-dark': {
    id: 'github-dark',
    label: 'GitHub Dark',
    scheme: 'dark',
    // 逐字沿用加主题之前的界面配色：默认主题必须与旧版本像素一致。
    colors: {
      bg: '#0d1117', paper: '#f6f8fa', panel: '#11161d',
      panelAlt: '#161b22', raised: '#1c232c', border: '#232b35',
      borderStrong: '#30363d', text: '#c9d1d9', dim: '#8b949e',
      faint: '#6e7681', accent: '#58a6ff', accentDim: '#1f6feb',
      selected: '#f0b429', selectedSoft: 'rgba(240, 180, 41, 0.16)', neighbor: '#79c0ff',
      danger: '#f85149', warn: '#d29922', ok: '#3fb950',
      nodeFill: '#1b222b', nodeFillExt: '#2a2f36', nodeStroke: '#39424e',
      edge: '#4a5563', edgeDim: '#2b333d', overlay: 'rgba(8, 11, 15, 0.72)',
      onAccent: '#ffffff', tooltipBg: '#1e1e1e', tooltipText: '#cccccc',
      dangerSoft: 'rgba(248, 81, 73, 0.12)', warnSoft: 'rgba(210, 153, 34, 0.1)', shadow: 'rgba(0, 0, 0, 0.4)',
      underline: 'rgba(201, 209, 217, 0.4)',
    },
    tokenColors: {
      plain: '#c9d1d9', keyword: '#ff7b72', string: '#a5d6ff',
      comment: '#7d8590', number: '#79c0ff', funcName: '#d2a8ff',
      className: '#ffa657', decorator: '#e3b341', operator: '#8b949e',
      identifier: '#c9d1d9', constant: '#79c0ff', self: '#ffa198',
      builtin: '#7ee787',
    },
    fileColors: [
      '#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f778ba',
      '#56d364', '#79c0ff', '#ffa657', '#a5d6ff', '#ff7b72',
    ] as const,
  },
  'github-light': {
    id: 'github-light',
    label: 'GitHub Light',
    scheme: 'light',
    // Primer 官方浅色。comment 取 #59636e 而非官方 #6e7781 —— 后者对 panel 只有 4.27，过不了 4.5 门禁。
    // 偏离官方配色的色值（同色相微调以过门禁）：
    // tok.decorator #9a6700 -> #976500
    colors: {
      bg: '#ffffff', paper: '#f6f8fa', panel: '#f6f8fa',
      panelAlt: '#eaeef2', raised: '#ffffff', border: '#d8dee4',
      borderStrong: '#d1d9e0', text: '#1f2328', dim: '#59636e',
      faint: '#6e7781', accent: '#0969da', accentDim: '#0969da',
      selected: '#bf8700', selectedSoft: 'rgba(212, 163, 7, 0.16)', neighbor: '#0550ae',
      danger: '#cf222e', warn: '#9a6700', ok: '#1a7f37',
      nodeFill: '#f6f8fa', nodeFillExt: '#eaeef2', nodeStroke: '#d1d9e0',
      edge: '#818b98', edgeDim: '#d8dee4', overlay: 'rgba(31, 35, 40, 0.45)',
      onAccent: '#ffffff', tooltipBg: '#1f2328', tooltipText: '#f6f8fa',
      dangerSoft: 'rgba(207, 34, 46, 0.08)', warnSoft: 'rgba(154, 103, 0, 0.08)', shadow: 'rgba(31, 35, 40, 0.28)',
      underline: 'rgba(31, 35, 40, 0.45)',
    },
    tokenColors: {
      plain: '#1f2328', keyword: '#cf222e', string: '#0a3069',
      comment: '#59636e', number: '#0550ae', funcName: '#8250df',
      className: '#953800', decorator: '#976500', operator: '#59636e',
      identifier: '#1f2328', constant: '#0550ae', self: '#bf3989',
      builtin: '#116329',
    },
    fileColors: [
      '#0969da', '#1a7f37', '#9a6700', '#8250df', '#bf3989',
      '#116329', '#0550ae', '#953800', '#0a3069', '#cf222e',
    ] as const,
  },
  'dracula': {
    id: 'dracula',
    label: 'Dracula',
    scheme: 'dark',
    // 官方 comment / 次级文字色 #6272a4 在深底上过不了门禁，同色相提亮（差异逐条列在下面）。
    // 偏离官方配色的色值（同色相微调以过门禁）：
    // dim #6272a4 -> #7d8bb4 / tok.comment #6272a4 -> #8692b9 / file[7] #6272a4 -> #6473a5
    // file[9] #44475a -> #6e7391
    colors: {
      bg: '#21222c', paper: '#f8f8f2', panel: '#282a36',
      panelAlt: '#343746', raised: '#44475a', border: '#44475a',
      borderStrong: '#6272a4', text: '#f8f8f2', dim: '#7d8bb4',
      faint: '#6272a4', accent: '#bd93f9', accentDim: '#6272a4',
      selected: '#f1fa8c', selectedSoft: 'rgba(241, 250, 140, 0.16)', neighbor: '#8be9fd',
      danger: '#ff5555', warn: '#ffb86c', ok: '#50fa7b',
      nodeFill: '#343746', nodeFillExt: '#44475a', nodeStroke: '#6272a4',
      edge: '#6272a4', edgeDim: '#44475a', overlay: 'rgba(17, 18, 26, 0.72)',
      onAccent: '#ffffff', tooltipBg: '#191a21', tooltipText: '#f8f8f2',
      dangerSoft: 'rgba(255, 85, 85, 0.14)', warnSoft: 'rgba(255, 184, 108, 0.14)', shadow: 'rgba(0, 0, 0, 0.5)',
      underline: 'rgba(248, 248, 242, 0.45)',
    },
    tokenColors: {
      plain: '#f8f8f2', keyword: '#ff79c6', string: '#f1fa8c',
      comment: '#8692b9', number: '#bd93f9', funcName: '#50fa7b',
      className: '#8be9fd', decorator: '#ffb86c', operator: '#ff79c6',
      identifier: '#f8f8f2', constant: '#bd93f9', self: '#ffb86c',
      builtin: '#8be9fd',
    },
    fileColors: [
      '#bd93f9', '#50fa7b', '#f1fa8c', '#ff79c6', '#8be9fd',
      '#ffb86c', '#ff5555', '#6473a5', '#f8f8f2', '#6e7391',
    ] as const,
  },
  'nord': {
    id: 'nord',
    label: 'Nord',
    scheme: 'dark',
    // 官方 frost 系列偏亮：accentDim #5e81ac 承不住白色前景（4.03），压暗到 #5477a2；强调类 token 同理提亮。
    // 偏离官方配色的色值（同色相微调以过门禁）：
    // accentDim #5e81ac -> #5477a2 / danger #bf616a -> #c0636c
    // tok.keyword #81a1c1 -> #99b3cd / tok.comment #7b88a1 -> #a8b0c1
    // tok.number #b48ead -> #c4a7bf / tok.decorator #d08770 -> #dba291
    // tok.operator #81a1c1 -> #99b3cd / tok.constant #b48ead -> #c4a7bf
    // tok.self #d08770 -> #dba291 / file[8] #5e81ac -> #7291b6 / file[9] #bf616a -> #c8777f
    colors: {
      bg: '#2e3440', paper: '#eceff4', panel: '#3b4252',
      panelAlt: '#434c5e', raised: '#4c566a', border: '#434c5e',
      borderStrong: '#4c566a', text: '#eceff4', dim: '#d8dee9',
      faint: '#81a1c1', accent: '#88c0d0', accentDim: '#5477a2',
      selected: '#ebcb8b', selectedSoft: 'rgba(235, 203, 139, 0.18)', neighbor: '#8fbcbb',
      danger: '#c0636c', warn: '#d08770', ok: '#a3be8c',
      nodeFill: '#3b4252', nodeFillExt: '#434c5e', nodeStroke: '#4c566a',
      edge: '#5e81ac', edgeDim: '#4c566a', overlay: 'rgba(20, 24, 31, 0.72)',
      onAccent: '#ffffff', tooltipBg: '#2e3440', tooltipText: '#e5e9f0',
      dangerSoft: 'rgba(191, 97, 106, 0.16)', warnSoft: 'rgba(208, 135, 112, 0.16)', shadow: 'rgba(0, 0, 0, 0.5)',
      underline: 'rgba(216, 222, 233, 0.45)',
    },
    tokenColors: {
      plain: '#d8dee9', keyword: '#99b3cd', string: '#a3be8c',
      comment: '#a8b0c1', number: '#c4a7bf', funcName: '#88c0d0',
      className: '#8fbcbb', decorator: '#dba291', operator: '#99b3cd',
      identifier: '#e5e9f0', constant: '#c4a7bf', self: '#dba291',
      builtin: '#8fbcbb',
    },
    fileColors: [
      '#88c0d0', '#a3be8c', '#ebcb8b', '#b48ead', '#d08770',
      '#8fbcbb', '#81a1c1', '#eceff4', '#7291b6', '#c8777f',
    ] as const,
  },
  'solarized-dark': {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    scheme: 'dark',
    // panel == bg 是刻意的：Solarized 只有 base03/base02 两级底色，token 门禁因此量在真实渲染面上。
    // 偏离官方配色的色值（同色相微调以过门禁）：
    // accentDim #268bd2 -> #217ab8 / tok.comment #586e75 -> #7a939b
    // tok.number #d33682 -> #de66a0 / tok.funcName #268bd2 -> #3295da
    // tok.decorator #cb4b16 -> #e96833 / tok.operator #6c71c4 -> #858ace
    // tok.self #dc322f -> #e56866 / tok.builtin #6c71c4 -> #858ace
    colors: {
      bg: '#002b36', paper: '#eee8d5', panel: '#002b36',
      panelAlt: '#073642', raised: '#073642', border: '#073642',
      borderStrong: '#586e75', text: '#93a1a1', dim: '#839496',
      faint: '#657b83', accent: '#268bd2', accentDim: '#217ab8',
      selected: '#b58900', selectedSoft: 'rgba(181, 137, 0, 0.2)', neighbor: '#2aa198',
      danger: '#dc322f', warn: '#cb4b16', ok: '#859900',
      nodeFill: '#073642', nodeFillExt: '#0a4353', nodeStroke: '#586e75',
      edge: '#586e75', edgeDim: '#073642', overlay: 'rgba(0, 20, 27, 0.72)',
      onAccent: '#ffffff', tooltipBg: '#073642', tooltipText: '#eee8d5',
      dangerSoft: 'rgba(220, 50, 47, 0.14)', warnSoft: 'rgba(203, 75, 22, 0.14)', shadow: 'rgba(0, 0, 0, 0.5)',
      underline: 'rgba(147, 161, 161, 0.45)',
    },
    tokenColors: {
      plain: '#93a1a1', keyword: '#859900', string: '#2aa198',
      comment: '#7a939b', number: '#de66a0', funcName: '#3295da',
      className: '#b58900', decorator: '#e96833', operator: '#858ace',
      identifier: '#93a1a1', constant: '#2a9e9c', self: '#e56866',
      builtin: '#858ace',
    },
    fileColors: [
      '#268bd2', '#859900', '#b58900', '#d33682', '#2aa198',
      '#cb4b16', '#6c71c4', '#839496', '#dc322f', '#93a1a1',
    ] as const,
  },
  'solarized-light': {
    id: 'solarized-light',
    label: 'Solarized Light',
    scheme: 'light',
    // panel == bg 同上；selected / neighbor / ok 与全部彩色 token 同色相压暗：官方中间调在 #fdf6e3 上过不了门禁。
    // 偏离官方配色的色值（同色相微调以过门禁）：
    // accentDim #268bd2 -> #217ab8 / selected #b58900 -> #b28700
    // neighbor #2aa198 -> #299d94 / ok #859900 -> #839600 / tok.keyword #859900 -> #667500
    // tok.string #2aa198 -> #207b74 / tok.comment #93a1a1 -> #637272
    // tok.number #d33682 -> #cb2c79 / tok.funcName #268bd2 -> #2074af
    // tok.className #b58900 -> #8c6a00 / tok.decorator #cb4b16 -> #c24815
    // tok.operator #6c71c4 -> #6166c0 / tok.constant #2a9e9c -> #217c7a
    // tok.self #dc322f -> #d72724 / tok.builtin #6c71c4 -> #6166c0
    // file[1] #859900 -> #839600 / file[2] #b58900 -> #b28700 / file[4] #2aa198 -> #299d94
    // file[9] #93a1a1 -> #809090
    colors: {
      bg: '#fdf6e3', paper: '#eee8d5', panel: '#fdf6e3',
      panelAlt: '#eee8d5', raised: '#eee8d5', border: '#eee8d5',
      borderStrong: '#93a1a1', text: '#073642', dim: '#586e75',
      faint: '#657b83', accent: '#268bd2', accentDim: '#217ab8',
      selected: '#b28700', selectedSoft: 'rgba(181, 137, 0, 0.2)', neighbor: '#299d94',
      danger: '#dc322f', warn: '#cb4b16', ok: '#839600',
      nodeFill: '#eee8d5', nodeFillExt: '#e4dcc6', nodeStroke: '#93a1a1',
      edge: '#93a1a1', edgeDim: '#eee8d5', overlay: 'rgba(238, 232, 213, 0.72)',
      onAccent: '#ffffff', tooltipBg: '#073642', tooltipText: '#fdf6e3',
      dangerSoft: 'rgba(220, 50, 47, 0.1)', warnSoft: 'rgba(203, 75, 22, 0.1)', shadow: 'rgba(88, 110, 117, 0.3)',
      underline: 'rgba(7, 54, 66, 0.45)',
    },
    tokenColors: {
      plain: '#073642', keyword: '#667500', string: '#207b74',
      comment: '#637272', number: '#cb2c79', funcName: '#2074af',
      className: '#8c6a00', decorator: '#c24815', operator: '#6166c0',
      identifier: '#002b36', constant: '#217c7a', self: '#d72724',
      builtin: '#6166c0',
    },
    fileColors: [
      '#268bd2', '#839600', '#b28700', '#d33682', '#299d94',
      '#cb4b16', '#6c71c4', '#586e75', '#dc322f', '#809090',
    ] as const,
  },
};

/** 6 套主题的字面调色板。预览面板直接读这里的 hex —— 变量只描述当前主题，描述不了别的主题。 */
export const THEMES: Record<ThemeId, ThemePalette> = PALETTES;

export const DEFAULT_THEME: ThemeId = 'github-dark';

/** 主题面板里的显示顺序：两套 GitHub 打底，其余按色温排 */
export const THEME_ORDER: readonly ThemeId[] = [
  'github-dark', 'github-light', 'dracula', 'nord', 'solarized-dark', 'solarized-light',
] as const;

function kebabKey(key: string): string {
  return key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/**
 * 把一套调色板摊平成「变量名 -> 色值」，共 54 条（31 UI + 13 token + 10 文件）。
 * 纯函数，jest 无 DOM 即可断言；themeVars.ts 遍历它的结果逐条 setProperty。
 */
export function cssVarsFor(palette: ThemePalette): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of Object.keys(palette.colors) as (keyof ColorTokens)[]) {
    vars['--cm-' + kebabKey(key)] = palette.colors[key];
  }
  for (const key of Object.keys(palette.tokenColors) as TokenScope[]) {
    vars['--cm-tok-' + kebabKey(key)] = palette.tokenColors[key];
  }
  palette.fileColors.forEach((value, index) => {
    vars['--cm-file-' + index] = value;
  });
  return vars;
}

/**
 * 界面引用的颜色：值全是 var(--cm-*)，实际色值由 <html> 上的当前主题决定。
 * 引用方（StyleSheet.create / 内联 style / SVG fill 属性）不需要知道主题的存在。
 * paper 是站点图标的底板色，也是图标契约测试的比对项（图标本身固定，不换主题）。
 */
export const colors: ColorTokens = {
  bg: 'var(--cm-bg)', paper: 'var(--cm-paper)',
  panel: 'var(--cm-panel)', panelAlt: 'var(--cm-panel-alt)',
  raised: 'var(--cm-raised)', border: 'var(--cm-border)',
  borderStrong: 'var(--cm-border-strong)', text: 'var(--cm-text)',
  dim: 'var(--cm-dim)', faint: 'var(--cm-faint)',
  accent: 'var(--cm-accent)', accentDim: 'var(--cm-accent-dim)',
  selected: 'var(--cm-selected)', selectedSoft: 'var(--cm-selected-soft)',
  neighbor: 'var(--cm-neighbor)', danger: 'var(--cm-danger)',
  warn: 'var(--cm-warn)', ok: 'var(--cm-ok)',
  nodeFill: 'var(--cm-node-fill)', nodeFillExt: 'var(--cm-node-fill-ext)',
  nodeStroke: 'var(--cm-node-stroke)', edge: 'var(--cm-edge)',
  edgeDim: 'var(--cm-edge-dim)', overlay: 'var(--cm-overlay)',
  onAccent: 'var(--cm-on-accent)', tooltipBg: 'var(--cm-tooltip-bg)',
  tooltipText: 'var(--cm-tooltip-text)', dangerSoft: 'var(--cm-danger-soft)',
  warnSoft: 'var(--cm-warn-soft)', shadow: 'var(--cm-shadow)',
  underline: 'var(--cm-underline)',
};

export const tokenColors: Record<TokenScope, string> = {
  plain: 'var(--cm-tok-plain)', keyword: 'var(--cm-tok-keyword)',
  string: 'var(--cm-tok-string)', comment: 'var(--cm-tok-comment)',
  number: 'var(--cm-tok-number)', funcName: 'var(--cm-tok-func-name)',
  className: 'var(--cm-tok-class-name)', decorator: 'var(--cm-tok-decorator)',
  operator: 'var(--cm-tok-operator)', identifier: 'var(--cm-tok-identifier)',
  constant: 'var(--cm-tok-constant)', self: 'var(--cm-tok-self)',
  builtin: 'var(--cm-tok-builtin)',
};

/** 按文件着色（图例 / 节点边框） */
export const FILE_COLORS: readonly string[] = [
  'var(--cm-file-0)', 'var(--cm-file-1)', 'var(--cm-file-2)', 'var(--cm-file-3)',
  'var(--cm-file-4)', 'var(--cm-file-5)', 'var(--cm-file-6)', 'var(--cm-file-7)',
  'var(--cm-file-8)', 'var(--cm-file-9)',
];

export function fileColor(index: number): string {
  return FILE_COLORS[((index % FILE_COLORS.length) + FILE_COLORS.length) % FILE_COLORS.length] as string;
}

export const fonts = {
  mono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
  ui:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
} as const;

/** 代码区度量：行高写死，窗口化列表才能 O(1) 计算滚动位置。度量不随主题变。 */
export const CODE_FONT_SIZE = 13;
export const ROW_H = 20;
export const GUTTER_W = 58;
export const RENDER_BUFFER_ROWS = 24;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;
