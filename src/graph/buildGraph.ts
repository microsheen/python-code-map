/**
 * 把解析产物组装成调用图：聚合重复边、保留自环、统计未解析调用。
 */
import { MODULE_FUNC } from '../parser/symbols';
import type {
  CallEdge,
  CallGraph,
  CallSite,
  FileAnalysis,
  FuncId,
  FuncSymbol,
  GraphStats,
  UnresolvedReason,
} from '../parser/types';


const REASONS: UnresolvedReason[] = ['ambiguous', 'external', 'dynamic', 'unknown'];

export function buildGraph(analyses: FileAnalysis[], ms = 0): CallGraph {
  const nodeById = new Map<FuncId, FuncSymbol>();
  const files: string[] = [];
  const allUnresolved: CallSite[] = [];
  const byReason: Record<UnresolvedReason, number> = {
    ambiguous: 0,
    external: 0,
    dynamic: 0,
    unknown: 0,
  };

  for (const a of analyses) {
    if (!files.includes(a.file.path)) files.push(a.file.path);
    for (const f of a.funcs) nodeById.set(f.id, f);
    if (!nodeById.has(a.moduleFunc.id)) {
      nodeById.set(a.moduleFunc.id, a.moduleFunc);
    }
  }

  const edgeMap = new Map<string, CallEdge>();
  for (const a of analyses) {
    for (const call of a.calls) {
      if (call.reason === 'resolved' && call.target && call.caller) {
        if (!nodeById.has(call.target)) continue;
        const key = `${call.caller}\u0000${call.target}`;
        const existing = edgeMap.get(key);
        if (existing) existing.callSites.push(call);
        else
          edgeMap.set(key, {
            source: call.caller,
            target: call.target,
            callSites: [call],
            selfLoop: call.caller === call.target,
          });
      } else {
        allUnresolved.push(call);
        if (call.reason !== 'resolved' && REASONS.includes(call.reason as UnresolvedReason)) {
          byReason[call.reason as UnresolvedReason] += 1;
        }
      }
    }
  }

  const edges = [...edgeMap.values()];
  const usedIds = new Set<FuncId>();
  for (const e of edges) {
    usedIds.add(e.source);
    usedIds.add(e.target);
  }

  // <module> 伪函数只有在真的产生了边时才进图，否则纯噪音
  const nodes = [...nodeById.values()].filter((n) => {
    if (n.name !== MODULE_FUNC || !n.synthetic) return true;
    return usedIds.has(n.id);
  });
  nodes.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.startLine - b.startLine;
  });

  const stats: GraphStats = {
    funcs: nodes.length,
    edges: edges.length,
    unresolved: allUnresolved.length,
    ms,
    byReason,
  };

  return { nodes, edges, unresolved: allUnresolved, files, stats };
}


export interface Adjacency {
  out: Map<FuncId, CallEdge[]>;
  inn: Map<FuncId, CallEdge[]>;
}

export function buildAdjacency(graph: CallGraph): Adjacency {
  const out = new Map<FuncId, CallEdge[]>();
  const inn = new Map<FuncId, CallEdge[]>();
  for (const e of graph.edges) {
    const o = out.get(e.source);
    if (o) o.push(e);
    else out.set(e.source, [e]);
    const i = inn.get(e.target);
    if (i) i.push(e);
    else inn.set(e.target, [e]);
  }
  return { out, inn };
}