/**
 * 代码区点击命中范围：callExprRange / buildClickRanges / hitClickRange。
 */
import {
  buildClickRanges,
  callExprRange,
  hitClickRange,
  type ClickRange,
} from '../src/components/CodePane/clickRanges';
import { makeFuncId } from '../src/parser/symbols';
import { callSite, func } from './helpers/synth';

const A = 'a.py';
const ID_ALPHA = makeFuncId(A, 'alpha');
const ID_BETA = makeFuncId(A, 'beta');
const ID_A = makeFuncId(A, 'a');

describe('callExprRange', () => {
  it('取出点号链被调名（utils.calc 共 10 字符 -> end=14）', () => {
    expect(callExprRange('    utils.calc(x)', 4)).toEqual({ start: 4, end: 14 });
  });
  it('简单名字', () => {
    expect(callExprRange('    foo()', 4)).toEqual({ start: 4, end: 7 });
  });
  it('列指向空白 -> null', () => {
    expect(callExprRange('    foo()', 3)).toBeNull();
  });
  it('列指向非名字字符（括号）-> null', () => {
    expect(callExprRange('foo()', 3)).toBeNull();
  });
  it('列越界 / 负数 / 空行 -> null', () => {
    expect(callExprRange('ab', 5)).toBeNull();
    expect(callExprRange('ab', -1)).toBeNull();
    expect(callExprRange('', 0)).toBeNull();
  });
});

describe('buildClickRanges', () => {
  const lines = ['import b', '', 'def alpha():', '    return beta()', '', 'def beta():', '    print(1)'];
  const fAlpha = func(A, 'alpha', { defLine: 3, startLine: 3, endLine: 4 });
  const fBeta = func(A, 'beta', { defLine: 6, startLine: 6, endLine: 7 });
  const modFn = func(A, '<module>', {
    synthetic: true,
    defLine: 1,
    nameRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
  });

  it('def 名生成 def 区间，指向函数本身', () => {
    const r = buildClickRanges([fAlpha, fBeta], [], lines);
    expect(r.get(3)).toEqual([{ start: 4, end: 9, funcId: ID_ALPHA, kind: 'def' }]);
    expect(r.get(6)).toEqual([{ start: 4, end: 8, funcId: ID_BETA, kind: 'def' }]);
  });

  it('跳过 synthetic 伪函数与空名区间', () => {
    const r = buildClickRanges([modFn], [], lines);
    expect(r.size).toBe(0);
  });

  it('已解析调用生成 call 区间，指向 callee', () => {
    const call = callSite({ file: A, line: 4, column: 11, text: 'beta', caller: ID_ALPHA, target: ID_BETA });
    const r = buildClickRanges([fAlpha], [call], lines);
    expect(r.get(4)).toEqual([{ start: 11, end: 15, funcId: ID_BETA, kind: 'call' }]);
  });

  it('未解析（external）调用不生成区间', () => {
    const ext = callSite({ file: A, line: 7, column: 4, text: 'print', caller: ID_BETA, reason: 'external' });
    const r = buildClickRanges([fBeta], [ext], lines);
    expect(r.get(7)).toBeUndefined();
  });

  it('同一行 def + call 两区间按 start 升序', () => {
    const src = ['def a(x=b()):', '    pass'];
    const fa = func(A, 'a', { defLine: 1, startLine: 1, endLine: 2 });
    const call = callSite({ file: A, line: 1, column: 8, text: 'b', caller: fa.id, target: ID_BETA });
    const r = buildClickRanges([fa], [call], src);
    expect(r.get(1)).toEqual([
      { start: 4, end: 5, funcId: ID_A, kind: 'def' },
      { start: 8, end: 9, funcId: ID_BETA, kind: 'call' },
    ]);
  });
});

describe('hitClickRange', () => {
  const defR: ClickRange = { start: 4, end: 9, funcId: ID_ALPHA, kind: 'def' };
  const callR: ClickRange = { start: 4, end: 9, funcId: ID_BETA, kind: 'call' };

  it('def 优先于 call（同列重叠）', () => {
    expect(hitClickRange([callR, defR], 5)).toBe(defR);
  });
  it('命中区间为 [start,end)', () => {
    expect(hitClickRange([defR], 4)).toBe(defR);
    expect(hitClickRange([defR], 8)).toBe(defR);
    expect(hitClickRange([defR], 9)).toBeNull();
  });
  it('空 / undefined -> null', () => {
    expect(hitClickRange([], 4)).toBeNull();
    expect(hitClickRange(undefined, 4)).toBeNull();
  });
});
