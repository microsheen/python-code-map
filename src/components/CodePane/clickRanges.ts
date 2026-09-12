/**
 * 代码区点击命中范围（纯函数，便于单测）。
 *
 * 两类可点击区间：
 * - def ：函数名 token，点击选中该函数本身
 * - call：已解析调用点的被调名字，点击选中 callee
 * 命中不到任何区间时，退化为"点击函数体内任意行" -> 选中最内层函数。
 */
import type { CallSite, FuncId, FuncSymbol } from '../../parser/types';

export type ClickKind = 'def' | 'call';

export interface ClickRange {
  /** 0-based 起始列（含） */
  start: number;
  /** 0-based 结束列（不含） */
  end: number;
  funcId: FuncId;
  kind: ClickKind;
}

export interface ColumnRange {
  start: number;
  end: number;
}

/** 调用表达式开头必须是一个名字 / 点号链，否则不做点击区间。 */
const NAME_EXPR_RE = /^[A-Za-z_][\w.]*/;

/**
 * 从行原文的 column 处取出被调用的名字区间。
 * 例如 "    utils.calc(x)" 且 column=4 -> { start: 4, end: 13 }（覆盖 utils.calc）。
 */
export function callExprRange(lineText: string, column: number): ColumnRange | null {
  if (!lineText || column < 0 || column >= lineText.length) return null;
  const m = NAME_EXPR_RE.exec(lineText.slice(column));
  if (!m || m[0].length === 0) return null;
  return { start: column, end: column + m[0].length };
}

/**
 * 逐行收集可点击区间。key 为 1-based 行号。
 * 同一行可能有多个区间（def 行里又有调用、一行里多个调用）。
 */
export function buildClickRanges(
  funcs: FuncSymbol[],
  calls: CallSite[],
  lines: string[],
): Map<number, ClickRange[]> {
  const out = new Map<number, ClickRange[]>();
  const push = (line: number, r: ClickRange): void => {
    const arr = out.get(line);
    if (arr) arr.push(r);
    else out.set(line, [r]);
  };

  for (const f of funcs) {
    if (f.synthetic) continue;
    const nr = f.nameRange;
    if (!nr || nr.endCol <= nr.startCol) continue;
    push(nr.startLine, { start: nr.startCol, end: nr.endCol, funcId: f.id, kind: 'def' });
  }

  for (const c of calls) {
    if (c.reason !== 'resolved' || !c.target) continue;
    const text = lines[c.line - 1];
    if (text === undefined) continue;
    const range = callExprRange(text, c.column);
    if (!range) continue;
    push(c.line, { start: range.start, end: range.end, funcId: c.target, kind: 'call' });
  }

  for (const arr of out.values()) arr.sort((a, b) => a.start - b.start);
  return out;
}

/** col 为 0-based 列；def 优先于 call（def 名里通常不会再嵌调用）。 */
export function hitClickRange(ranges: ClickRange[] | undefined, col: number): ClickRange | null {
  if (!ranges || ranges.length === 0) return null;
  for (const r of ranges) {
    if (r.kind === 'def' && col >= r.start && col < r.end) return r;
  }
  for (const r of ranges) {
    if (col >= r.start && col < r.end) return r;
  }
  return null;
}
