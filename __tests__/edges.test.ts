/**
 * 「第 k/N 处调用」的唯一口径：边 key 与调用点排序。
 *
 * 图那边点边循环、代码那边 callIndex、步进器显示的数字，三处必须指同一件事，
 * 所以这里把顺序和越界行为钉死，任何一边改口径都会在这里失败。
 */
import {
  callSiteAt,
  compareCallSites,
  edgeKey,
  findEdge,
  sortedCallSites,
  splitEdgeKey,
} from '../src/graph/edges';
import { layoutGraph } from '../src/graph/layout';
import { makeFuncId } from '../src/parser/symbols';
import { callSite, edge, func, graphOf } from './helpers/synth';
import type { CallEdge, CallSite } from '../src/parser/types';

const F = 'pkg/mod.py';
const ID_A = makeFuncId(F, 'A.a');
const ID_B = makeFuncId(F, 'B.b');
const ID_C = makeFuncId(F, 'c');

const site = (line: number, column: number, text = ''): CallSite =>
  callSite({ file: F, line, column, text, caller: ID_A, target: ID_B });

describe('edgeKey / splitEdgeKey', () => {
  it('key 的拼法固定为 source + "->" + target', () => {
    expect(edgeKey(ID_A, ID_B)).toBe('pkg/mod.py::A.a->pkg/mod.py::B.b');
  });

  it('正解能还原两个端点（点中边之后 store 靠这个反解）', () => {
    expect(splitEdgeKey(edgeKey(ID_A, ID_B))).toEqual({ source: ID_A, target: ID_B });
  });

  it('只按第一个 "->" 切：真实的函数 id 里不会出现它', () => {
    expect(splitEdgeKey('a.py::x->b.py::y->z')).toEqual({ source: 'a.py::x', target: 'b.py::y->z' });
  });

  it('没有 "->" 时返回 null（不让半截字符串混进边命中）', () => {
    expect(splitEdgeKey('nope')).toBeNull();
  });

  it('与 layoutGraph 里的 EdgePath.id 同源', () => {
    const g = graphOf(
      [func(F, 'A.a', { defLine: 1 }), func(F, 'B.b', { defLine: 9 })],
      [edge(ID_A, ID_B, [site(3, 4, 'b')])],
    );
    const laid = layoutGraph(g);
    expect(laid.edges.map((e) => e.id)).toEqual([edgeKey(ID_A, ID_B)]);
  });
});

describe('compareCallSites / sortedCallSites', () => {
  it('行升序优先，其次列，最后原文兜底', () => {
    const a = site(2, 8);
    const b = site(2, 4);
    const c = site(1, 40);
    expect([a, b, c].sort(compareCallSites).map((s) => [s.line, s.column])).toEqual([
      [1, 40],
      [2, 4],
      [2, 8],
    ]);
    const samePos = [site(5, 5, 'zz'), site(5, 5, 'aa')].sort(compareCallSites);
    expect(samePos.map((s) => s.text)).toEqual(['aa', 'zz']);
  });

  it('不改变传入 edge 的 callSites 顺序（图对象是共享数据，就地排序会串味）', () => {
    const e = edge(ID_A, ID_B, [site(9, 1), site(3, 2)]);
    const before = e.callSites.map((s) => s.line);
    const sorted = sortedCallSites(e);
    expect(sorted.map((s) => s.line)).toEqual([3, 9]);
    expect(e.callSites.map((s) => s.line)).toEqual(before);
    expect(sorted).not.toBe(e.callSites);
  });

  it('null / undefined / 空边 -> 空数组', () => {
    expect(sortedCallSites(null)).toEqual([]);
    expect(sortedCallSites(undefined)).toEqual([]);
    const bare: CallEdge = { source: ID_A, target: ID_B, callSites: [], selfLoop: false };
    expect(sortedCallSites(bare)).toEqual([]);
  });
});

describe('findEdge', () => {
  const g = graphOf(
    [func(F, 'A.a', { defLine: 1 }), func(F, 'B.b', { defLine: 9 }), func(F, 'c', { defLine: 20 })],
    [edge(ID_A, ID_B, [site(3, 4, 'b')]), edge(ID_C, ID_A, [site(21, 4, 'a')])],
  );

  it('按端点找到聚合边', () => {
    expect(findEdge(g, ID_A, ID_B)?.callSites).toHaveLength(1);
    expect(findEdge(g, ID_C, ID_A)?.source).toBe(ID_C);
  });

  it('有向：反方向找不到', () => {
    expect(findEdge(g, ID_B, ID_A)).toBeNull();
  });

  it('图不存在时返回 null', () => {
    expect(findEdge(null, ID_A, ID_B)).toBeNull();
    expect(findEdge(undefined, ID_A, ID_B)).toBeNull();
  });
});

describe('callSiteAt', () => {
  const e = edge(ID_A, ID_B, [site(9, 1), site(3, 2), site(3, 0)]);

  it('按下标取排序后的第 k 个（0-based，与 UI 上的 "k+1/N" 对应）', () => {
    expect(callSiteAt(e, 0)?.line).toBe(3);
    expect(callSiteAt(e, 1)?.column).toBe(2);
    expect(callSiteAt(e, 2)?.line).toBe(9);
  });

  it('越界 / 负数 -> null，由调用方决定兜底', () => {
    expect(callSiteAt(e, 3)).toBeNull();
    expect(callSiteAt(e, -1)).toBeNull();
    expect(callSiteAt(null, 0)).toBeNull();
  });
});
