/**
 * 深色主题 + 度量常量。浅色主题暂不做，颜色集中在这里便于以后加变量。
 */
import type { TokenScope } from './parser/types';

export const colors = {
  bg: '#0d1117',
  /** 浅色纸面：站点图标底板，也是未来浅色主题的种子色 */
  paper: '#f6f8fa',
  panel: '#11161d',
  panelAlt: '#161b22',
  raised: '#1c232c',
  border: '#232b35',
  borderStrong: '#30363d',
  text: '#c9d1d9',
  dim: '#8b949e',
  faint: '#6e7681',
  accent: '#58a6ff',
  accentDim: '#1f6feb',
  selected: '#f0b429',
  selectedSoft: 'rgba(240, 180, 41, 0.16)',
  neighbor: '#79c0ff',
  danger: '#f85149',
  warn: '#d29922',
  ok: '#3fb950',
  nodeFill: '#1b222b',
  nodeFillExt: '#2a2f36',
  nodeStroke: '#39424e',
  edge: '#4a5563',
  edgeDim: '#2b333d',
  overlay: 'rgba(8, 11, 15, 0.72)',
} as const;

export const tokenColors: Record<TokenScope, string> = {
  plain: '#c9d1d9',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  comment: '#7d8590',
  number: '#79c0ff',
  funcName: '#d2a8ff',
  className: '#ffa657',
  decorator: '#e3b341',
  operator: '#8b949e',
  identifier: '#c9d1d9',
  constant: '#79c0ff',
  self: '#ffa198',
  builtin: '#7ee787',
};

/** 按文件着色（图例 / 节点边框） */
export const FILE_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#bc8cff',
  '#f778ba',
  '#56d364',
  '#79c0ff',
  '#ffa657',
  '#a5d6ff',
  '#ff7b72',
] as const;

export function fileColor(index: number): string {
  return FILE_COLORS[((index % FILE_COLORS.length) + FILE_COLORS.length) % FILE_COLORS.length] as string;
}

export const fonts = {
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
  ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
} as const;

/** 代码区度量：行高写死，窗口化列表才能 O(1) 计算滚动位置 */
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