/**
 * 图范围裁剪：邻域 / 本文件 / 全部。
 * 纯函数，便于快照测试。
 */
import { EXTERNAL_NODE_ID, buildAdjacency, externalNode } from './buildGraph';
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

/** 把 external 调用聚合成一个灰色节点（showExternal 开关）。 */
export function withExternalNode(graph: CallGraph): CallGraph {
  const sites = new Map<FuncId, CallSite[]>();
  for (const u of graph.unresolved) {
    if (u.reason !== 'external' || !u.caller) continue;
    const arr = sites.get(u.caller);
    if (arr) arr.push(u);
    else sites.set(u.caller, [u]);
  }
  if (sites.size === 0) return graph;
  const edges: CallEdge[] = [...graph.edges];
  for (const [caller, callSites] of sites) {
    edges.push({ source: caller, target: EXTERNAL_NODE_ID, callSites, selfLoop: false });
  }
  const nodes: FuncSymbol[] = [...graph.nodes, externalNode()];
  return {
    ...graph,
    nodes,
    edges,
    stats: { ...graph.stats, funcs: nodes.length, edges: edges.length },
  };
}

function subgraph(graph: CallGraph, keep: Set<FuncId>): CallGraph {
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const unresolved = graph.unresolved.filter((u) => u.caller !== null && keep.has(u.caller));
  return {
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
  options: { showExternal?: boolean } = {},
): CallGraph {
  const g = options.showExternal ? withExternalNode(graph) : graph;
  if (scope.kind === 'all') return g;

  if (scope.kind === 'neighborhood') {
    if (!g.nodes.some((n) => n.id === scope.funcId)) return g;
    const keep = expand(g, [scope.funcId], Math.max(0, scope.depth));
    return subgraph(g, keep);
  }

  // file：本文件全部函数 + 直接触达它们的跨文件邻居（否则边画不出来）
  const seeds = g.nodes.filter((n) => n.file === scope.file).map((n) => n.id);
  if (seeds.length === 0) return subgraph(g, new Set());
  return subgraph(g, expand(g, seeds, 1));
}

export function scopeContains(graph: CallGraph, id: FuncId): boolean {
  return graph.nodes.some((n) => n.id === id);
}

export function isLarge(graph: CallGraph): boolean {
  return graph.nodes.length > LARGE_GRAPH_THRESHOLD;
}