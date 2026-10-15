/**
 * 派生数据的 React hooks。都做了 useMemo，避免每次渲染都重算子图 / 布局。
 */
import { useMemo } from 'react';
import { buildAdjacency } from '../graph/buildGraph';
import { edgeKey } from '../graph/edges';
import { layoutGraph, type LayoutResult } from '../graph/layout';
import { applyScope } from '../graph/scope';
import type { CallGraph, FuncId, FuncSymbol, LineTokens } from '../parser/types';
import { useAppStore } from './store';

/** 当前 scope 下的子图。 */
export function useScopedGraph(): CallGraph | null {
  const graph = useAppStore((s) => s.graph);
  const scope = useAppStore((s) => s.scope);
  return useMemo(
    () => (graph ? applyScope(graph, scope) : null),
    [graph, scope],
  );
}

/** 子图的 dagre 布局。 */
export function useLayout(graph: CallGraph | null): LayoutResult | null {
  return useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
}

export function useNodeIndex(graph: CallGraph | null): Map<FuncId, FuncSymbol> {
  return useMemo(() => {
    const m = new Map<FuncId, FuncSymbol>();
    if (graph) for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);
}

/** 选中节点的直接 callers / callees（半高亮用）。 */
export function useNeighborIds(graph: CallGraph | null, funcId: FuncId | null): Set<FuncId> {
  return useMemo(() => {
    const out = new Set<FuncId>();
    if (!graph || !funcId) return out;
    const adj = buildAdjacency(graph);
    for (const e of adj.out.get(funcId) ?? []) out.add(e.target);
    for (const e of adj.inn.get(funcId) ?? []) out.add(e.source);
    return out;
  }, [graph, funcId]);
}

/** 选中节点的直接连边 id 集合。 */
export function useNeighborEdgeIds(graph: CallGraph | null, funcId: FuncId | null): Set<string> {
  return useMemo(() => {
    const out = new Set<string>();
    if (!graph || !funcId) return out;
    for (const e of graph.edges) {
      if (e.source === funcId || e.target === funcId) out.add(edgeKey(e.source, e.target));
    }
    return out;
  }, [graph, funcId]);
}

export function useActiveFileLines(): { path: string | null; lines: string[]; tokens: LineTokens[] } {
  const activeFile = useAppStore((s) => s.activeFile);
  const files = useAppStore((s) => s.files);
  const highlights = useAppStore((s) => s.highlights);
  return useMemo(() => {
    const file = files.find((f) => f.path === activeFile) ?? null;
    return {
      path: file?.path ?? null,
      lines: file?.lines ?? [],
      tokens: (file && highlights.get(file.path)) || [],
    };
  }, [activeFile, files, highlights]);
}

export function useFuncIndex(): Map<FuncId, FuncSymbol> {
  const analyses = useAppStore((s) => s.analyses);
  return useMemo(() => {
    const m = new Map<FuncId, FuncSymbol>();
    for (const a of analyses) {
      for (const f of a.funcs) m.set(f.id, f);
      m.set(a.moduleFunc.id, a.moduleFunc);
    }
    return m;
  }, [analyses]);
}