/**
 * 图范围裁剪：邻域 / 本文件 / 全部。
 */
import {
  ALL_SCOPE,
  DEFAULT_DEPTH,
  LARGE_GRAPH_THRESHOLD,
  applyScope,
  fileScope,
  isLarge,
  neighborhoodScope,
  scopeContains,
} from '../src/graph/scope';
import { makeFuncId } from '../src/parser/symbols';
import { callSite, edge, func, graphOf, pyFile } from './helpers/synth';

const F = 'f.py';
const id = (q: string): string => makeFuncId(F, q);

function chainGraph() {
  // a -> b -> c, d -> b, a -> e ；e 只通过 a 二跳可达
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((q, i) =>
    func(F, q, { defLine: i * 3 + 1 }),
  );
  const edges = [
    edge(id('a'), id('b')),
    edge(id('b'), id('c')),
    edge(id('d'), id('b')),
    edge(id('a'), id('e')),
  ];
  return graphOf(nodes, edges);
}

function ids(g: { nodes: { id: string }[] }): string[] {
  return g.nodes.map((n) => n.id).sort();
}

describe('neighborhoodScope', () => {
  it('默认深度为 1', () => {
    expect(DEFAULT_DEPTH).toBe(1);
    expect(neighborhoodScope('x')).toEqual({ kind: 'neighborhood', funcId: 'x', depth: 1 });
  });

  it('depth=1 只含直接 callers / callees', () => {
    const g = chainGraph();
    const sub = applyScope(g, neighborhoodScope(id('b'), 1));
    expect(ids(sub)).toEqual([id('a'), id('b'), id('c'), id('d')].sort());
    // e 是 a 的另一个 callee，不在 b 的一跳邻域里
    expect(sub.edges.map((e) => e.source + '->' + e.target)).not.toContain(
      id('a') + '->' + id('e'),
    );
  });

  it('depth=0 只保留自身', () => {
    const sub = applyScope(chainGraph(), neighborhoodScope(id('b'), 0));
    expect(ids(sub)).toEqual([id('b')]);
    expect(sub.edges).toHaveLength(0);
  });

  it('depth=2 向外扩两跳', () => {
    const sub = applyScope(chainGraph(), neighborhoodScope(id('b'), 2));
    expect(ids(sub)).toEqual(
      [id('a'), id('b'), id('c'), id('d'), id('e')].sort(),
    );
  });

  it('目标不在图里时原样返回（不裁成空图）', () => {
    const g = chainGraph();
    expect(applyScope(g, neighborhoodScope('nope::x', 1))).toBe(g);
  });

  it('子图只保留两端都在范围内的边，并同步 stats', () => {
    const sub = applyScope(chainGraph(), neighborhoodScope(id('c'), 1));
    expect(ids(sub)).toEqual([id('b'), id('c')].sort());
    expect(sub.edges).toHaveLength(1);
    expect(sub.stats.funcs).toBe(2);
    expect(sub.stats.edges).toBe(1);
    expect(sub.files).toEqual([F]);
  });
});

describe('fileScope', () => {
  const X = 'x.py';
  const Y = 'y.py';

  function twoFileGraph() {
    const nodes = [
      func(X, 'x1', { defLine: 1 }),
      func(X, 'x2', { defLine: 4 }),
      func(Y, 'y1', { defLine: 1 }),
      func(Y, 'y2', { defLine: 9 }),
    ];
    const edges = [
      edge(makeFuncId(X, 'x1'), makeFuncId(X, 'x2')),
      edge(makeFuncId(Y, 'y1'), makeFuncId(X, 'x1')),
      edge(makeFuncId(X, 'x2'), makeFuncId(Y, 'y1')),
    ];
    return graphOf(nodes, edges, [], [X, Y]);
  }

  it('本文件全部函数 + 直接触达它们的跨文件邻居', () => {
    const sub = applyScope(twoFileGraph(), fileScope(X));
    expect(ids(sub)).toEqual(
      [makeFuncId(X, 'x1'), makeFuncId(X, 'x2'), makeFuncId(Y, 'y1')].sort(),
    );
    expect(sub.edges).toHaveLength(3);
    expect(sub.files.sort()).toEqual([X, Y]);
  });

  it('无关文件里的孤立函数被裁掉', () => {
    const sub = applyScope(twoFileGraph(), fileScope(X));
    expect(scopeContains(sub, makeFuncId(Y, 'y2'))).toBe(false);
  });

  it('文件不存在时得到空子图', () => {
    const sub = applyScope(twoFileGraph(), fileScope('zzz.py'));
    expect(sub.nodes).toHaveLength(0);
    expect(sub.edges).toHaveLength(0);
  });
});

describe('all scope', () => {
  it('原样返回同一个引用', () => {
    const g = chainGraph();
    expect(applyScope(g, ALL_SCOPE)).toBe(g);
    expect(ALL_SCOPE).toEqual({ kind: 'all' });
  });
});


describe('isLarge / scopeContains', () => {
  it('超过阈值才提示图较大', () => {
    const at = graphOf(
      Array.from({ length: LARGE_GRAPH_THRESHOLD }, (_, i) => func(F, 'n' + i, { defLine: i + 1 })),
      [],
      [],
      [F],
    );
    expect(isLarge(at)).toBe(false);
    const over = graphOf(
      Array.from({ length: LARGE_GRAPH_THRESHOLD + 1 }, (_, i) =>
        func(F, 'n' + i, { defLine: i + 1 }),
      ),
      [],
      [],
      [F],
    );
    expect(isLarge(over)).toBe(true);
  });

  it('unresolved 也会跟着子图裁剪', () => {
    const g = chainGraph();
    const withUnresolved = graphOf(
      g.nodes,
      g.edges,
      [
        callSite({ file: F, line: 1, caller: id('a'), reason: 'unknown' }),
        callSite({ file: F, line: 2, caller: id('e'), reason: 'unknown' }),
      ],
      [F],
    );
    const sub = applyScope(withUnresolved, neighborhoodScope(id('b'), 1));
    expect(sub.unresolved).toHaveLength(1);
    expect(sub.unresolved[0]?.caller).toBe(id('a'));
  });
});

it('pyFile 辅助函数正常', () => {
  const f = pyFile('a/b.py', 'x = 1\r\ny = 2\n');
  expect(f.path).toBe('a/b.py');
  expect(f.name).toBe('b.py');
  expect(f.lines).toEqual(['x = 1', 'y = 2', '']);
});
