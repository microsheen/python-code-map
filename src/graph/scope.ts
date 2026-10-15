/**
 * 图范围裁剪：邻域 / 本文件 / 全部。
 * 纯函数，便于快照测试。
 */
import { buildAdjacency } from './buildGraph';
import type { CallEdge, CallGraph, CallSite, FuncId, FuncSymbol } from '../parser/types';

export type Scope =
  | { kind: 'neighborhood'; funcId: FuncId; depth: number }
  | { kind: 'file'; file: string }
  | { kind: 'all' };

export const ALL_SCOPE: Scope = { kind: 'all' };
export const DEFAULT_DEPTH = 1;
/** 超过这个节点数时提示"图较大" */
export const LARGE_GRAPH_THRESHOLD = 400;

export function neighborhoodScope(funcId: FuncId, depth = DEFAULT_DEPTH): Scope {
  return { kind: 'neighborhood', funcId, depth };
}

export function fileScope(file: string): Scope {
  return { kind: 'file', file };
}

function subgraph(graph: CallGraph, keep: Set<FuncId>): CallGraph {
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const unresolved = graph.unresolved.filter((u) => u.caller !== null && keep.has(u.caller));
  return {
    ...graph,
    nodes,
    edges,
    unresolved,
    files: [...new Set(nodes.map((n) => n.file))],
    stats: {
      ...graph.stats,
      funcs: nodes.length,
      edges: edges.length,
      unresolved: unresolved.length,
    },
  };
}

function expand(graph: CallGraph, seeds: FuncId[], depth: number): Set<FuncId> {
  const adj = buildAdjacency(graph);
  const seen = new Set<FuncId>(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: FuncId[] = [];
    for (const id of frontier) {
      for (const e of adj.out.get(id) ?? []) {
        if (!seen.has(e.target)) {
          seen.add(e.target);
          next.push(e.target);
        }
      }
      for (const e of adj.inn.get(id) ?? []) {
        if (!seen.has(e.source)) {
          seen.add(e.source);
          next.push(e.source);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export function applyScope(
  graph: CallGraph,
  scope: Scope,
): CallGraph {
  if (scope.kind === 'all') return graph;

  if (scope.kind === 'neighborhood') {
    if (!graph.nodes.some((n) => n.id === scope.funcId)) return graph;
    const keep = expand(graph, [scope.funcId], Math.max(0, scope.depth));
    return subgraph(graph, keep);
  }

  // file：本文件全部函数 + 直接触达它们的跨文件邻居（否则边画不出来）
  const seeds = graph.nodes.filter((n) => n.file === scope.file).map((n) => n.id);
  if (seeds.length === 0) return subgraph(graph, new Set());
  return subgraph(graph, expand(graph, seeds, 1));
}

export function scopeContains(graph: CallGraph, id: FuncId): boolean {
  return graph.nodes.some((n) => n.id === id);
}

export function isLarge(graph: CallGraph): boolean {
  return graph.nodes.length > LARGE_GRAPH_THRESHOLD;
}
