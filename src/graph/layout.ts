/**
 * dagre 分层布局的纯函数包装（rankdir = LR）。
 * 无副作用、无 DOM 依赖，便于快照测试。
 */
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';
import type { CallGraph, FuncId, FuncSymbol } from '../parser/types';
import { edgeKey } from './edges';

export const NODE_H_SINGLE = 34;
export const NODE_H_DOUBLE = 48;
/** 13px monospace 下的平均字符宽度 */
export const CHAR_W = 7.2;
export const MIN_NODE_W = 104;
export const MAX_NODE_W = 300;
export const PAD_X = 28;
export const RANK_SEP = 96;
export const NODE_SEP = 22;
export const EDGE_SEP = 14;
export const MARGIN = 28;
/** 自环向外鼓出的距离 */
export const SELF_LOOP_BULGE = 46;

export interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export const ARROW_SIZE = 9;
export const ARROW_HALF_W = 4.2;

/** 箭头尖端位置与朝向（角度为度，0 = 向右，顺时针为正）。 */
export interface ArrowTip {
  x: number;
  y: number;
  angle: number;
}

/**
 * 手画三角形箭头。
 * 不用 SVG <Marker>：react-native-svg 的 web 实现对 marker 支持不稳定，
 * 手画在两端表现一致，而且是纯函数、可快照测试。
 */
export function arrowHeadPath(tip: ArrowTip, size = ARROW_SIZE, half = ARROW_HALF_W): string {
  const a = (tip.angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const px = -uy;
  const py = ux;
  const bx = tip.x - size * ux;
  const by = tip.y - size * uy;
  return (
    'M ' + r(tip.x) + ' ' + r(tip.y) +
    ' L ' + r(bx + half * px) + ' ' + r(by + half * py) +
    ' L ' + r(bx - half * px) + ' ' + r(by - half * py) +
    ' Z'
  );
}

/** 从折线最后两点推箭头方向（指向终点）。 */
export function tipFromPoints(pts: Pt[]): ArrowTip {
  const last = pts[pts.length - 1] as Pt;
  let prev = pts.length >= 2 ? (pts[pts.length - 2] as Pt) : { x: last.x - 1, y: last.y };
  if (prev.x === last.x && prev.y === last.y) prev = { x: last.x - 1, y: last.y };
  return {
    x: last.x,
    y: last.y,
    angle: (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI,
  };
}

/** 自环的箭头：落在节点右边框上，方向取自贝塞尔末端的切线。 */
export function selfLoopTip(box: NodeBox): ArrowTip {
  const x = box.x + box.w;
  const yBottom = box.y + box.h * 0.68;
  const cx = x + SELF_LOOP_BULGE;
  const cy = box.y + box.h + 6;
  return {
    x,
    y: yBottom,
    angle: (Math.atan2(yBottom - cy, x - cx) * 180) / Math.PI,
  };
}

export interface EdgePath {
  id: string;
  source: FuncId;
  target: FuncId;
  d: string;
  weight: number;
  strokeWidth: number;
  selfLoop: boolean;
  /** 折线中点，用于画调用次数角标 */
  mid: { x: number; y: number };
  /** 箭头尖端与朝向 */
  arrow: ArrowTip;
  /**
   * 与 d 渲染形状一致的密采样折线（自环是采样后的三次贝塞尔）。
   * 命中检测只用它，不去解析 d 字符串：这样「看到的线」和「点得中的线」同源。
   */
  points: Pt[];
  /** points 的外接框，hover 预筛用 */
  bbox: BBox;
}

export interface LayoutResult {
  nodes: Map<FuncId, NodeBox>;
  edges: EdgePath[];
  width: number;
  height: number;
  showFile: boolean;
}

export function nodeLabel(f: FuncSymbol): string {
  return f.qualifiedName || f.name;
}

export function fileLabel(f: FuncSymbol): string {
  if (!f.file) return '';
  const parts = f.file.split('/');
  return parts.length > 1 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : (parts[0] ?? '');
}

export function nodeSize(f: FuncSymbol, showFile: boolean): { w: number; h: number } {
  const label = nodeLabel(f);
  const sub = showFile ? fileLabel(f) : '';
  const longest = Math.max(label.length, sub.length * 0.78);
  const w = Math.round(Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, longest * CHAR_W + PAD_X)));
  return { w, h: showFile && sub ? NODE_H_DOUBLE : NODE_H_SINGLE };
}

export function edgeStrokeWidth(weight: number): number {
  return Math.round(Math.min(4, 1 + Math.log2(1 + Math.max(0, weight))) * 10) / 10;
}

export interface Pt {
  x: number;
  y: number;
}

/** 采样点集的外接框，hover 命中时的廉价预筛用。 */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function pointsToPath(points: Pt[]): string {
  if (points.length === 0) return '';
  const p0 = points[0] as Pt;
  if (points.length === 1) return `M ${r(p0.x)} ${r(p0.y)}`;
  if (points.length === 2) {
    const p1 = points[1] as Pt;
    return `M ${r(p0.x)} ${r(p0.y)} L ${r(p1.x)} ${r(p1.y)}`;
  }
  let d = `M ${r(p0.x)} ${r(p0.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i] as Pt;
    const nxt = points[i + 1] as Pt;
    const midX = (cur.x + nxt.x) / 2;
    const midY = (cur.y + nxt.y) / 2;
    d += ` Q ${r(cur.x)} ${r(cur.y)} ${r(midX)} ${r(midY)}`;
  }
  const last = points[points.length - 1] as Pt;
  d += ` L ${r(last.x)} ${r(last.y)}`;
  return d;
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 每段二次曲线的细分段数 */
export const QUAD_SAMPLES = 8;
/** 自环三次贝塞尔的细分段数 */
export const CUBIC_SAMPLES = 16;

/**
 * 二次贝塞尔采样，返回**不含**起点的 steps 个点（含终点）。
 * 与 pointsToPath 里一段 Q 的形状逐点一致，命中检测才不会和看到的线漂移。
 */
export function sampleQuadratic(p0: Pt, c: Pt, p1: Pt, steps = QUAD_SAMPLES): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
  return out;
}

/** 三次贝塞尔采样，返回**不含**起点的 steps 个点（含终点）。 */
export function sampleCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, steps = CUBIC_SAMPLES): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y,
    });
  }
  return out;
}

/**
 * 把 dagre 折线按 pointsToPath 的同一套规则摊成密采样折线。
 * 起点必须保留（它是命中区的一部分），所以从 points[0] 开始累积。
 * 两个点时是直线：中间补一个点，让「点到线段距离」至少有一段可算。
 */
export function sampleSmoothedPolyline(points: Pt[]): Pt[] {
  if (points.length === 0) return [];
  const p0 = points[0] as Pt;
  if (points.length === 1) return [{ ...p0 }, { ...p0 }];
  if (points.length === 2) {
    const p1 = points[1] as Pt;
    return [{ ...p0 }, { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, { ...p1 }];
  }
  const out: Pt[] = [{ ...p0 }];
  let cur = p0;
  for (let i = 1; i < points.length - 1; i++) {
    const ctrl = points[i] as Pt;
    const end = points[i + 1] as Pt;
    const mid = { x: (ctrl.x + end.x) / 2, y: (ctrl.y + end.y) / 2 };
    out.push(...sampleQuadratic(cur, ctrl, mid));
    cur = mid;
  }
  const last = points[points.length - 1] as Pt;
  out.push({ x: (cur.x + last.x) / 2, y: (cur.y + last.y) / 2 }, { ...last });
  return out;
}

export function bboxOf(points: Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** 自环的四个控制点：起于节点右边框上部，鼓出后回到下部。画 path 与采样共用同一份几何。 */
export function selfLoopCurve(box: NodeBox): { p0: Pt; c1: Pt; c2: Pt; p1: Pt } {
  const x = box.x + box.w;
  const yTop = box.y + box.h * 0.32;
  const yBottom = box.y + box.h * 0.68;
  const b = SELF_LOOP_BULGE;
  return {
    p0: { x, y: yTop },
    c1: { x: x + b, y: box.y - 6 },
    c2: { x: x + b, y: box.y + box.h + 6 },
    p1: { x, y: yBottom },
  };
}

function selfLoopPath(box: NodeBox): string {
  const { p0, c1, c2, p1 } = selfLoopCurve(box);
  return (
    `M ${r(p0.x)} ${r(p0.y)} ` +
    `C ${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(p1.x)} ${r(p1.y)}`
  );
}

export function layoutGraph(graph: CallGraph): LayoutResult {
  const showFile = new Set(graph.nodes.map((n) => n.file)).size > 1;
  const g = new graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    edgesep: EDGE_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  const nodes = new Map<FuncId, NodeBox>();
  for (const n of graph.nodes) {
    const { w, h } = nodeSize(n, showFile);
    g.setNode(n.id, { width: w, height: h, label: nodeLabel(n) });
  }
  for (const e of graph.edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    g.setEdge(e.source, e.target, { width: 0, height: 0, minlen: e.selfLoop ? 1 : 1 });
  }

  if (graph.nodes.length > 0) dagreLayout(g);

  for (const n of graph.nodes) {
    const laid = g.node(n.id) as ({ x: number; y: number } & { width: number; height: number }) | undefined;
    const { w, h } = nodeSize(n, showFile);
    const cx = laid?.x ?? w / 2;
    const cy = laid?.y ?? h / 2;
    nodes.set(n.id, { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
  }

  const edges: EdgePath[] = [];
  for (const e of graph.edges) {
    const src = nodes.get(e.source);
    const dst = nodes.get(e.target);
    if (!src || !dst) continue;
    const weight = e.callSites.length;
    if (e.selfLoop || e.source === e.target) {
      const loop = selfLoopCurve(src);
      const loopPts = [loop.p0, ...sampleCubic(loop.p0, loop.c1, loop.c2, loop.p1)];
      edges.push({
        id: edgeKey(e.source, e.target),
        source: e.source,
        target: e.target,
        d: selfLoopPath(src),
        weight,
        strokeWidth: edgeStrokeWidth(weight),
        selfLoop: true,
        mid: { x: src.x + src.w + SELF_LOOP_BULGE * 0.75, y: src.cy },
        arrow: selfLoopTip(src),
        points: loopPts,
        bbox: bboxOf(loopPts),
      });
      continue;
    }
    const laid = g.edge({ v: e.source, w: e.target }) as { points?: Pt[] } | undefined;
    const pts = laid?.points && laid.points.length >= 2 ? laid.points : [
      { x: src.x + src.w, y: src.cy },
      { x: dst.x, y: dst.cy },
    ];
    const sampled = sampleSmoothedPolyline(pts);
    const midIdx = Math.floor(pts.length / 2);
    const mid = pts[midIdx] ?? { x: (src.cx + dst.cx) / 2, y: (src.cy + dst.cy) / 2 };
    edges.push({
      id: edgeKey(e.source, e.target),
      source: e.source,
      target: e.target,
      d: pointsToPath(pts),
      weight,
      strokeWidth: edgeStrokeWidth(weight),
      selfLoop: false,
      mid: { x: mid.x, y: mid.y },
      arrow: tipFromPoints(pts),
      points: sampled,
      bbox: bboxOf(sampled),
    });
  }

  const graphMeta = g.graph() as { width?: number; height?: number };
  const width = Math.max(1, graphMeta.width ?? MARGIN * 2);
  const height = Math.max(1, graphMeta.height ?? MARGIN * 2);
  return { nodes, edges, width, height, showFile };
}

/** 让 (cx, cy) 落到视口中心的变换。 */
export function centerTransform(
  cx: number,
  cy: number,
  viewportW: number,
  viewportH: number,
  scale: number,
): { tx: number; ty: number } {
  return { tx: viewportW / 2 - cx * scale, ty: viewportH / 2 - cy * scale };
}

/** 适应窗口：返回能装下 width x height 的 scale 与居中位移。 */
export function fitTransform(
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  minScale = 0.3,
  maxScale = 1.2,
): { tx: number; ty: number; scale: number } {
  if (viewportW <= 0 || viewportH <= 0 || width <= 0 || height <= 0) {
    return { tx: 0, ty: 0, scale: 1 };
  }
  const scale = Math.min(maxScale, Math.max(minScale, Math.min(viewportW / width, viewportH / height)));
  return { tx: (viewportW - width * scale) / 2, ty: (viewportH - height * scale) / 2, scale };
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.5;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}