/**
 * 边的公共语义：key 的拼法、调用点的稳定顺序、按端点查边。
 *
 * 图上的一条边是「同一对函数之间全部调用」的聚合（见 ADR-0002），聚合后仍然保留
 * 每一次调用的 file/line/column/text。本模块把这些 CallSite 的**展示顺序**定为唯一口径：
 * 按 (line, column) 升序。UI 上「第 1/3 处调用」的序号完全由这个顺序决定，任何地方
 * 需要序号都从这里取，不要在别处再 sort 一次或依赖 buildGraph 的插入顺序。
 *
 * 一个不变量（`collectCalls` 保证了它）：一条边的全部 callSites 都在同一个文件里 ——
 * caller 是一个函数，只可能定义在一个文件内，它的调用点自然都在那个文件。代码区因此
 * 不需要跨文件分组标记。
 */
import type { CallEdge, CallGraph, CallSite, FuncId } from '../parser/types';

/**
 * 边的稳定标识。与 `layout.ts` 里 `EdgePath.id`、`hooks.useNeighborEdgeIds` 的拼法同源，
 * 全项目只准这一处拼。
 */
export function edgeKey(source: FuncId, target: FuncId): string {
  return `${source}->${target}`;
}

/** 从 edgeKey 反解端点；只按第一个 '->' 切，函数 id 里不会出现它。 */
export function splitEdgeKey(key: string): { source: FuncId; target: FuncId } | null {
  const i = key.indexOf('->');
  if (i < 0) return null;
  return { source: key.slice(0, i), target: key.slice(i + 2) };
}

/** 调用点的源码顺序：行号升序 → 同行按列升序 → 原文兜底。「第几处」的唯一比较器。 */
export function compareCallSites(a: CallSite, b: CallSite): number {
  return a.line - b.line || a.column - b.column || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}

/**
 * 一条边的调用点，按「源码顺序」稳定排列：行号升序，同行按列升序，再按原文兜底。
 * 返回副本，不改动 edge。
 */
export function sortedCallSites(edge: CallEdge | null | undefined): CallSite[] {
  if (!edge) return [];
  return [...edge.callSites].sort(compareCallSites);
}

export function findEdge(
  graph: CallGraph | null | undefined,
  source: FuncId,
  target: FuncId,
): CallEdge | null {
  if (!graph) return null;
  for (const e of graph.edges) if (e.source === source && e.target === target) return e;
  return null;
}

/** 当前序号（0-based）对应的调用点；越界返回 null，让调用方决定怎么兜底。 */
export function callSiteAt(edge: CallEdge | null | undefined, index: number): CallSite | null {
  const sites = sortedCallSites(edge);
  if (index < 0 || index >= sites.length) return null;
  return sites[index] ?? null;
}
