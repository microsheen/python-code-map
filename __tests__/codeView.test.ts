/**
 * 代码区窗口化与分片纯函数：computeWindow / buildPieces（不渲染组件）。
 */
import {
  FALLBACK_CHAR_W,
  FLASH_MS,
  MEASURE_CHARS,
  buildPieces,
  computeWindow,
} from '../src/components/CodePane/CodeView';
import type { ClickRange } from '../src/components/CodePane/clickRanges';
import { RENDER_BUFFER_ROWS, ROW_H, tokenColors } from '../src/theme';
import { span } from './helpers/synth';

describe('computeWindow', () => {
  it('total<=0 -> {first:1,last:0}', () => {
    expect(computeWindow(0, 600, 0)).toEqual({ first: 1, last: 0 });
    expect(computeWindow(100, 600, -5)).toEqual({ first: 1, last: 0 });
  });
  it('顶部：first 夹到 1，last = 视口行数 + buffer', () => {
    const w = computeWindow(0, 600, 10000);
    expect(w.first).toBe(1);
    expect(w.last).toBe(Math.ceil(600 / ROW_H) + RENDER_BUFFER_ROWS);
  });
  it('中部：first/last 围绕滚动位置 +/- buffer', () => {
    const scrollTop = 2000;
    const w = computeWindow(scrollTop, 600, 10000);
    expect(w.first).toBe(Math.floor(scrollTop / ROW_H) - RENDER_BUFFER_ROWS);
    expect(w.last).toBe(Math.ceil((scrollTop + 600) / ROW_H) + RENDER_BUFFER_ROWS);
  });
  it('底部：last 夹到 total', () => {
    const w = computeWindow(9999 * ROW_H, 600, 10000);
    expect(w.last).toBe(10000);
  });
  it('视口为 0 也不会 first>last', () => {
    const w = computeWindow(0, 0, 5);
    expect(w.first).toBeLessThanOrEqual(w.last);
  });
});

describe('buildPieces', () => {
  it('空文本 -> []', () => {
    expect(buildPieces(1, '', undefined, undefined)).toEqual([]);
  });
  it('无 ranges：按 span 着色，全部不可点击', () => {
    const pieces = buildPieces(3, 'def alpha():', [span(0, 3, 'keyword'), span(4, 9, 'funcName')], undefined);
    expect(pieces.map((p) => p.text)).toEqual(['def', ' ', 'alpha', '():']);
    expect(pieces.every((p) => !p.clickable && p.funcId === null)).toBe(true);
    expect(pieces[0]?.color).toBe(tokenColors.keyword);
  });
  it('有 ranges：在区间边界切开，命中片段带 funcId/kind', () => {
    const ranges: ClickRange[] = [{ start: 4, end: 9, funcId: 'a.py::alpha', kind: 'def' }];
    const pieces = buildPieces(3, 'def alpha():', [span(0, 3, 'keyword'), span(4, 9, 'funcName')], ranges);
    const clickable = pieces.filter((p) => p.clickable);
    expect(clickable).toHaveLength(1);
    expect(clickable[0]).toMatchObject({ text: 'alpha', funcId: 'a.py::alpha', kind: 'def' });
  });
  it('span 未覆盖的文本补 plain', () => {
    const pieces = buildPieces(1, 'abcd', undefined, undefined);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ text: 'abcd', color: tokenColors.plain });
  });
});

describe('CodeView 常量', () => {
  it('导出测量 / 闪烁常量', () => {
    expect(MEASURE_CHARS).toBe(100);
    expect(FALLBACK_CHAR_W).toBe(7.2);
    expect(FLASH_MS).toBe(1200);
  });
});
