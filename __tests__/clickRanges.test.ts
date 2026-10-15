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
import { analysisOf, callSite, func, graphFromAnalyses, pyFile } from './helpers/synth';
import { findEdge, sortedCallSites } from '../src/graph/edges';

const NL = String.fromCharCode(10);
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

  it('已解析调用生成 call 区间，指向 callee 并带反向点亮边所需的信息', () => {
    const call = callSite({ file: A, line: 4, column: 11, text: 'beta', caller: ID_ALPHA, target: ID_BETA });
    const r = buildClickRanges([fAlpha], [call], lines);
    expect(r.get(4)).toEqual([
      { start: 11, end: 15, funcId: ID_BETA, kind: 'call', caller: ID_ALPHA, callIndex: 0 },
    ]);
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
      { start: 8, end: 9, funcId: ID_BETA, kind: 'call', caller: fa.id, callIndex: 0 },
    ]);
  });
  it('A 调 B 三次：callIndex 按源码顺序（行 -> 列）编号，跨行也连续', () => {
    const src = ['def caller():', '    b()', '    x = 1; b()', '    b()', '    pass'];
    const fCaller = func(A, 'caller', { defLine: 1, startLine: 1, endLine: 5 });
    // 故意乱序传入：编号不能依赖调用方给的顺序
    const calls = [
      callSite({ file: A, line: 4, column: 4, text: 'b', caller: fCaller.id, target: ID_BETA }),
      callSite({ file: A, line: 3, column: 11, text: 'b', caller: fCaller.id, target: ID_BETA }),
      callSite({ file: A, line: 2, column: 4, text: 'b', caller: fCaller.id, target: ID_BETA }),
    ];
    const r = buildClickRanges([fCaller], calls, src);
    expect(r.get(2)).toEqual([
      { start: 4, end: 5, funcId: ID_BETA, kind: 'call', caller: fCaller.id, callIndex: 0 },
    ]);
    expect(r.get(3)).toEqual([
      { start: 11, end: 12, funcId: ID_BETA, kind: 'call', caller: fCaller.id, callIndex: 1 },
    ]);
    expect(r.get(4)).toEqual([
      { start: 4, end: 5, funcId: ID_BETA, kind: 'call', caller: fCaller.id, callIndex: 2 },
    ]);
  });

  it('序号按 (caller, target) 分组：不同边各自从 0 开始编号', () => {
    const src = ['def caller():', '    b()', '    c()', '    b()', '    pass'];
    const fCaller = func(A, 'caller', { defLine: 1, startLine: 1, endLine: 5 });
    const idC = makeFuncId(A, 'c');
    const calls = [
      callSite({ file: A, line: 2, column: 4, text: 'b', caller: fCaller.id, target: ID_BETA }),
      callSite({ file: A, line: 3, column: 4, text: 'c', caller: fCaller.id, target: idC }),
      callSite({ file: A, line: 4, column: 4, text: 'b', caller: fCaller.id, target: ID_BETA }),
    ];
    const r = buildClickRanges([fCaller], calls, src);
    expect((r.get(2) ?? [])[0]?.callIndex).toBe(0);
    expect((r.get(3) ?? [])[0]?.callIndex).toBe(0);
    expect((r.get(4) ?? [])[0]?.callIndex).toBe(1);
  });

  it('callIndex 与图那边 sortedCallSites 的下标逐一对应（真实聚合，防两套口径漂移）', () => {
    const src = ['def caller():', '    b()', '    y = 1; b()', '    b()', 'def b():', '    pass'];
    const fCaller = func(A, 'caller', { defLine: 1, startLine: 1, endLine: 4 });
    const fB = func(A, 'b', { defLine: 5, startLine: 5, endLine: 6 });
    const calls = [
      callSite({ file: A, line: 3, column: 11, text: 'b', caller: fCaller.id, target: fB.id }),
      callSite({ file: A, line: 4, column: 4, text: 'b', caller: fCaller.id, target: fB.id }),
      callSite({ file: A, line: 2, column: 4, text: 'b', caller: fCaller.id, target: fB.id }),
    ];
    const file = pyFile(A, src.join(NL));
    const g = graphFromAnalyses([analysisOf(file, [fCaller, fB], calls)]);
    const sites = sortedCallSites(findEdge(g, fCaller.id, fB.id));
    expect(sites).toHaveLength(3);
    const ranges = buildClickRanges([fCaller, fB], calls, src);
    sites.forEach((site, i) => {
      const hit = (ranges.get(site.line) ?? []).find((x) => x.start === site.column);
      expect(hit?.kind).toBe('call');
      expect(hit?.callIndex).toBe(i);
      expect(hit?.caller).toBe(fCaller.id);
    });
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
