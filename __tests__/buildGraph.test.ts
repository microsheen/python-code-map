/**
 * 建图：重复边聚合、自环、<module> 伪节点、reason 统计、邻接表。
 */
import {
  buildAdjacency,
  buildGraph,
  unresolvedCountByFunc,
} from '../src/graph/buildGraph';
import { makeFuncId, moduleId } from '../src/parser/symbols';
import type { CallSite, FuncId } from '../src/parser/types';
import { analysisOf, callSite, func, pyFile } from './helpers/synth';

const F = 'm.py';
const ID_A: FuncId = makeFuncId(F, 'a');
const ID_B: FuncId = makeFuncId(F, 'b');
const ID_C: FuncId = makeFuncId(F, 'c');
const MOD: FuncId = moduleId(F);

function site(line: number, caller: FuncId | null, target: FuncId | null, text = 'x'): CallSite {
  return callSite({ file: F, line, column: 4, caller, target, text });
}

describe('buildGraph 边聚合', () => {
  it('同一对函数的多次调用合并成一条边，callSites 全部保留', () => {
    const calls = [site(2, ID_A, ID_B, 'b'), site(3, ID_A, ID_B, 'b'), site(4, ID_A, ID_B, 'b')];
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a'), func(F, 'b')], calls)], 7);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.callSites).toHaveLength(3);
    expect(g.edges[0]?.selfLoop).toBe(false);
    expect(g.stats.ms).toBe(7);
    expect(g.stats.edges).toBe(1);
  });

  it('递归调用保留为自环并打上 selfLoop 标记', () => {
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a')], [site(2, ID_A, ID_A, 'a')])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.selfLoop).toBe(true);
    expect(g.edges[0]?.source).toBe(ID_A);
    expect(g.edges[0]?.target).toBe(ID_A);
  });

  it('target 不在图里时整条调用被丢弃，既不成边也不算未解析', () => {
    const g = buildGraph([
      analysisOf(pyFile(F, 'x'), [func(F, 'a')], [site(2, ID_A, makeFuncId(F, 'ghost'), 'ghost')]),
    ]);
    expect(g.edges).toHaveLength(0);
    expect(g.unresolved).toHaveLength(0);
    expect(g.stats.unresolved).toBe(0);
  });
});

describe('buildGraph <module> 伪节点', () => {
  it('没有产生任何边时被丢弃（避免噪音）', () => {
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a')], [])]);
    expect(g.nodes.some((n) => n.id === MOD)).toBe(false);
    expect(g.nodes.map((n) => n.id)).toEqual([ID_A]);
  });

  it('承载了模块级调用时保留', () => {
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a')], [site(1, MOD, ID_A, 'a')])]);
    expect(g.nodes.some((n) => n.id === MOD)).toBe(true);
    expect(g.edges[0]?.source).toBe(MOD);
  });
});

describe('buildGraph 统计', () => {
  it('按 reason 分桶计数未解析调用', () => {
    const calls = [
      callSite({ file: F, line: 1, caller: ID_A, reason: 'external', text: 'print' }),
      callSite({ file: F, line: 2, caller: ID_A, reason: 'external', text: 'len' }),
      callSite({ file: F, line: 3, caller: ID_A, reason: 'ambiguous', text: 'describe' }),
      callSite({ file: F, line: 4, caller: ID_A, reason: 'dynamic', text: 'fn' }),
      callSite({ file: F, line: 5, caller: ID_A, reason: 'unknown', text: '?' }),
    ];
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a')], calls)]);
    expect(g.stats.byReason).toEqual({ ambiguous: 1, external: 2, dynamic: 1, unknown: 1 });
    expect(g.stats.unresolved).toBe(5);
    expect(g.unresolved).toHaveLength(5);
    expect(g.stats.funcs).toBe(1);
  });

  it('files 去重且保持首次出现顺序', () => {
    const g = buildGraph([
      analysisOf(pyFile('b.py', ''), []),
      analysisOf(pyFile('a.py', ''), []),
      analysisOf(pyFile('b.py', ''), []),
    ]);
    expect(g.files).toEqual(['b.py', 'a.py']);
  });

  it('节点按 file 再按 startLine 排序', () => {
    const g = buildGraph([
      analysisOf(pyFile('b.py', ''), [
        func('b.py', 'late', { defLine: 9 }),
        func('b.py', 'early', { defLine: 1 }),
      ]),
      analysisOf(pyFile('a.py', ''), [func('a.py', 'q', { defLine: 3 })]),
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual([
      makeFuncId('a.py', 'q'),
      makeFuncId('b.py', 'early'),
      makeFuncId('b.py', 'late'),
    ]);
  });
});

describe('unresolvedCountByFunc', () => {
  it('按 caller 聚合角标计数，caller 为 null 的忽略', () => {
    const calls = [
      callSite({ file: F, line: 1, caller: ID_A, reason: 'external', text: 'print' }),
      callSite({ file: F, line: 2, caller: ID_A, reason: 'dynamic', text: 'fn' }),
      callSite({ file: F, line: 3, caller: ID_B, reason: 'unknown', text: 'q' }),
      callSite({ file: F, line: 4, caller: null, reason: 'external', text: 'open' }),
    ];
    const g = buildGraph([analysisOf(pyFile(F, 'x'), [func(F, 'a'), func(F, 'b')], calls)]);
    const m = unresolvedCountByFunc(g);
    expect(m.get(ID_A)).toBe(2);
    expect(m.get(ID_B)).toBe(1);
    expect(m.size).toBe(2);
  });
});

describe('buildAdjacency', () => {
  it('分别按 source / target 建出边表', () => {
    const calls = [
      site(2, ID_A, ID_B),
      site(3, ID_A, ID_C),
      site(4, ID_C, ID_B),
    ];
    const g = buildGraph([
      analysisOf(pyFile(F, 'x'), [func(F, 'a'), func(F, 'b'), func(F, 'c')], calls),
    ]);
    const adj = buildAdjacency(g);
    expect(adj.out.get(ID_A)?.map((e) => e.target)).toEqual([ID_B, ID_C]);
    expect(adj.inn.get(ID_B)?.map((e) => e.source)).toEqual([ID_A, ID_C]);
    expect(adj.out.get(ID_B)).toBeUndefined();
    expect(adj.inn.get(ID_A)).toBeUndefined();
  });
});

