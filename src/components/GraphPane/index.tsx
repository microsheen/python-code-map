/**
 * 右半区：函数调用关系图（SVG）。
 *
 * 渲染：单个 <Svg>，内部一个 <G transform="translate(tx,ty) scale(s)"> 承载全部内容。
 * 先画边（Path + 手画三角箭头；不用 SVG marker，因为 react-native-svg 的 web 实现对
 * marker 支持不稳，手画在两端表现一致且是纯函数、可快照测试），再画节点
 * （Rect + Text）。
 *
 * 交互：
 * - 滚轮缩放，以光标为锚点。订阅的是原生 wheel 且非被动（passive:false），
 *   否则 preventDefault 失效、页面会跟着一起滚。
 * - 按住拖动平移。拖动超过 DRAG_SLOP 像素后抑制节点 press，避免"拖一下"被误判成点击。
 * - 点击节点 -> selectFromGraph -> 左侧代码切文件 / 滚动到 def 行 / 闪烁函数体。
 * - 左侧点击函数 -> 这里按 selection.nonce 重新居中，并高亮该节点与其直接连边。
 * - 点击边 -> selectEdgeFromGraph -> 左侧代码定位到「A 调用 B」那一行；同一条边再点一次
 *   循环切到下一个调用点（Shift+点 反向），点空白清除。见 ADR-0005。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CHAR_W,
  arrowHeadPath,
  centerTransform,
  clampScale,
  fileLabel,
  fitTransform,
  nodeLabel,
} from '../../graph/layout';
import type { EdgePath, NodeBox, Pt } from '../../graph/layout';
import { edgeKey, findEdge, sortedCallSites, splitEdgeKey } from '../../graph/edges';
import { isLarge } from '../../graph/scope';
import type { FuncId, FuncSymbol } from '../../parser/types';
import {
  asElement,
  localPoint,
  startPointerDrag,
  subscribePointerDown,
  subscribePointerLeave,
  subscribePointerMove,
  subscribeWheel,
} from '../../platform/web/domEvents';
import {
  useLayout,
  useNeighborEdgeIds,
  useNeighborIds,
  useNodeIndex,
  useScopedGraph,
} from '../../state/hooks';
import { useAppStore } from '../../state/store';
import type { ViewElement } from '../viewRef';
import { colors, fileColor, fonts, spacing } from '../../theme';

/** jsdom 不会触发 onLayout，给一个兜底视口，保证测试与首帧仍能算出居中变换。 */
export const DEFAULT_VIEWPORT = { w: 960, h: 640 };
/** 拖动超过这个像素数就认定是平移，不再触发节点点击 */
export const DRAG_SLOP = 4;
export const ZOOM_IN = 1.25;
export const ZOOM_OUT = 0.8;
/** 滚轮缩放灵敏度：deltaMode=1（按行）时每一行的系数 */
export const WHEEL_LINE_FACTOR = 0.05;
/** deltaMode=0（按像素）时每一像素的系数 */
export const WHEEL_PIXEL_FACTOR = 0.0016;
/**
 * 有选中项时，非邻居节点的不透明度。
 *
 * 目标是"压暗"而不是"隐藏"：0.6 时节点文字与深色背景的对比度仍有约 4.5:1，
 * 读得清函数名，同时和满不透明度、边框加粗的选中/相邻节点拉开明显层次。
 * 再往下（例如 0.3）文字会灰到看不清，往上则失去聚焦效果。
 */
export const DIM_OPACITY = 0.7;
/** 非邻居连边的不透明度：边比节点再暗一档，避免背景连线抢走视线 */
export const EDGE_DIM_OPACITY = 0.7;
export const NODE_RADIUS = 7;

/**
 * 边的命中容差，单位是**屏幕像素**（世界容差 = tolPx / scale）。
 * 用屏幕像素而不是世界坐标，缩到 20% 时细线依然点得中；7px 大致是箭头的宽度，
 * 再放大容易让相邻的两条边互相抢命中。
 */
export const EDGE_HIT_TOL = 7;
/** 边数超过这个值就不做 hover 命中（点击仍然可用）：鼠标每动一下全量扫描太贵。 */
export const MAX_HOVER_EDGES = 1500;
/** 指针在同一条已命中的边上移动时，累计位移超过这个像素才更新 tooltip 位置。 */
export const HOVER_MOVE_SLOP = 6;
/** tooltip 与指针的间距，以及固定宽高（用来把气泡夹在画布内） */
export const TIP_OFFSET = 12;
export const TIP_W = 260;
export const TIP_H = 26;

const CURSOR_GRAB = { cursor: 'default', userSelect: 'none' } as unknown as ViewStyle;
const NO_TOUCH = { touchAction: 'none' } as unknown as ViewStyle;

/** 滚轮一次事件对应的缩放倍率。 */
export function wheelScaleFactor(deltaY: number, deltaMode: number): number {
  const unit = deltaMode === 1 ? WHEEL_LINE_FACTOR : WHEEL_PIXEL_FACTOR;
  return Math.exp(-deltaY * unit);
}

export interface ViewBox {
  tx: number;
  ty: number;
  scale: number;
}

/**
 * 以 (anchorX, anchorY)（容器内坐标）为不动点缩放。
 * 纯函数，便于单测：缩放前后该点对应的世界坐标不变。
 */
export function zoomAround(
  view: ViewBox,
  anchorX: number,
  anchorY: number,
  nextScaleRaw: number
): ViewBox {
  const nextScale = clampScale(nextScaleRaw);
  if (nextScale === view.scale) return view;
  const wx = (anchorX - view.tx) / view.scale;
  const wy = (anchorY - view.ty) / view.scale;
  return { tx: anchorX - wx * nextScale, ty: anchorY - wy * nextScale, scale: nextScale };
}

/**
 * 容器内坐标 -> 命中的节点 id，命中不到返回 null。
 *
 * 纯函数：把"这个点落在哪个矩形里"从 DOM 事件里剥出来。视图坐标到世界坐标的换算
 * 只有这一处（view 的逆变换），拖动平移与点击命中都走它，避免两套算法各自漂移。
 */
export function hitTestNode(
  nodes: Map<FuncId, NodeBox>,
  view: ViewBox,
  local: { x: number; y: number },
): FuncId | null {
  const wx = (local.x - view.tx) / view.scale;
  const wy = (local.y - view.ty) / view.scale;
  for (const [id, box] of nodes) {
    if (wx >= box.x && wx <= box.x + box.w && wy >= box.y && wy <= box.y + box.h) return id;
  }
  return null;
}

/** 点 (px,py) 到线段 ab 的最短距离（投影参数夹在 [0,1]，退化的零长线段按点算）。 */
export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 容器内坐标 -> 命中的边 id，命中不到返回 null。
 *
 * 与 hitTestNode 同构：只做视图逆变换 + 几何比较，不碰 DOM。命中用的是 layout 里
 * 与 d 同源密采样的 points，所以「看到的线」和「点得中的线」不会各自漂移；
 * 容差换算回世界坐标，缩放不改变手指/鼠标实际需要瞄准的像素宽度。
 * 多条边同时命中时取最近的；bbox 预筛只是加速，外扩了一个容差，不会漏。
 */
export function hitTestEdge(
  edges: EdgePath[],
  view: ViewBox,
  local: { x: number; y: number },
  tolPx: number = EDGE_HIT_TOL,
): string | null {
  const wx = (local.x - view.tx) / view.scale;
  const wy = (local.y - view.ty) / view.scale;
  const tol = tolPx / view.scale;
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const e of edges) {
    const b = e.bbox;
    if (wx < b.minX - tol || wx > b.maxX + tol || wy < b.minY - tol || wy > b.maxY + tol) continue;
    const pts = e.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Pt;
      const p = pts[i] as Pt;
      const d = distToSegment(wx, wy, a.x, a.y, p.x, p.y);
      if (d < bestDist) {
        bestDist = d;
        bestId = e.id;
      }
    }
  }
  return bestDist <= tol ? bestId : null;
}

/** 节点标签按节点宽度截断，超出用省略号。 */
export function fitLabel(label: string, boxW: number): string {
  const max = Math.max(6, Math.floor((boxW - 16) / CHAR_W));
  if (label.length <= max) return label;
  return label.slice(0, Math.max(1, max - 1)) + '\u2026';
}

export interface GraphNodeViewProps {
  func: FuncSymbol;
  box: NodeBox;
  colorIndex: number;
  selected: boolean;
  neighbor: boolean;
  dimmed: boolean;
  /** 这条边被点选中时的端点：用邻居色描边，一眼看出线连的是哪两个函数 */
  edgeEndpoint: boolean;
  showFile: boolean;
  /** 节点自身不挂 onPress：命中由容器的 pointer 事件 + hitTestNode 决定。 */
}

export const GraphNodeView = memo(function GraphNodeView(props: GraphNodeViewProps): ReactNode {
  const { func, box, colorIndex, selected, neighbor, dimmed, edgeEndpoint, showFile } = props;
  const onEdge = neighbor || edgeEndpoint;
  const stroke = selected
    ? colors.selected
    : onEdge
      ? colors.neighbor
      : fileColor(colorIndex);
  const label = fitLabel(nodeLabel(func), box.w);
  const textY = showFile ? box.y + 20 : box.y + box.h / 2 + 4.5;
  const sub = showFile ? fileLabel(func) : '';

  return (
    <G
      testID={'graph-node-' + func.id}
      opacity={dimmed ? DIM_OPACITY : 1}
    >
      <Rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={NODE_RADIUS}
        ry={NODE_RADIUS}
        fill={colors.nodeFill}
        stroke={stroke}
        strokeWidth={selected ? 2.6 : onEdge ? 1.9 : 1.3}
      />
      <SvgText
        x={box.cx}
        y={textY}
        textAnchor="middle"
        fontSize={13}
        fontFamily={fonts.mono}
        fontWeight={selected ? '700' : '400'}
        fill={selected ? colors.selected : colors.text}
      >
        {label}
      </SvgText>
      {sub ? (
        <SvgText
          x={box.cx}
          y={box.y + 36}
          textAnchor="middle"
          fontSize={10}
          fontFamily={fonts.ui}
          fill={colors.faint}
        >
          {sub}
        </SvgText>
      ) : null}
    </G>
  );
});

export function GraphPane(): ReactNode {
  const scoped = useScopedGraph();
  const layout = useLayout(scoped);
  const fullGraph = useAppStore((s) => s.graph);
  const selection = useAppStore((s) => s.selection);
  const selectFromGraph = useAppStore((s) => s.selectFromGraph);
  const view = useAppStore((s) => s.view);
  const fitNonce = useAppStore((s) => s.fitNonce);
  const fitView = useAppStore((s) => s.fitView);
  const status = useAppStore((s) => s.status);
  const progress = useAppStore((s) => s.progress);

  const nodeIndex = useNodeIndex(scoped);
  const neighbors = useNeighborIds(scoped, selection.funcId);
  const neighborEdges = useNeighborEdgeIds(scoped, selection.funcId);
  const edgeSelection = useAppStore((s) => s.edgeSelection);
  const selectedEdgeId = edgeSelection ? edgeKey(edgeSelection.source, edgeSelection.target) : null;
  /** 选中边的两端节点：用邻居色描边，一眼看出这条线连的是哪两个函数 */
  const edgeEndpoints = useMemo(() => {
    const out = new Set<FuncId>();
    if (edgeSelection) {
      out.add(edgeSelection.source);
      out.add(edgeSelection.target);
    }
    return out;
  }, [edgeSelection]);
  /** hover 命中的边（容器内坐标 + id）；null 表示没有 */
  const [hoverEdge, setHoverEdge] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 文件 -> 颜色下标。用全量图的 files，避免裁剪范围时颜色跳变。 */
  const colorIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    const src = fullGraph ?? scoped;
    if (src) src.files.forEach((f, i) => m.set(f, i));
    return m;
  }, [fullGraph, scoped]);

  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const containerRef = useRef<ViewElement | null>(null);
  const layoutRef = useRef(layout);
  /** 拖动中：抑制紧随其后的 press */
  const suppressPress = useRef(false);
  const fittedFor = useRef<{ nonce: number; w: number; h: number } | null>(null);
  const centeredNonce = useRef(-1);
  /** hover 命中：待处理的指针位置 + rAF 句柄（一次移动最多算一次） */
  const hoverPending = useRef<{ x: number; y: number } | null>(null);
  const hoverRaf = useRef(0);
  const hoverEnabledRef = useRef(true);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const onContainerLayout = (e: LayoutChangeEvent): void => {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setViewport((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height }
    );
  };

  // 滚轮缩放（非被动监听，见 domEvents.subscribeWheel）
  useEffect(() => {
    const el = asElement(containerRef);
    return subscribeWheel(el, (e) => {
      const p = localPoint(el, e.clientX, e.clientY);
      const st = useAppStore.getState();
      const next = zoomAround(
        st.view,
        p.x,
        p.y,
        st.view.scale * wheelScaleFactor(e.deltaY, e.deltaMode)
      );
      if (next === st.view) return;
      st.setView(next);
    });
  }, []);

  // 拖动平移
  useEffect(() => {
    const el = asElement(containerRef);
    return subscribePointerDown(el, (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const origin = useAppStore.getState().view;
      let moved = 0;
      suppressPress.current = false;
      startPointerDrag(e, {
        onMove: (dx, dy) => {
          moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
          if (moved > DRAG_SLOP) suppressPress.current = true;
          useAppStore.getState().setView({ tx: origin.tx + dx, ty: origin.ty + dy });
        },
        onEnd: (upEvent) => {
          if (suppressPress.current) {
            setTimeout(() => {
              suppressPress.current = false;
            }, 0);
          } else {
            // 没有拖动 -> hit-test 看点击了哪个节点
            const curLayout = layoutRef.current;
            if (curLayout) {
              const curEl = asElement(containerRef);
              const lp = localPoint(curEl, upEvent.clientX, upEvent.clientY);
              const hit = hitTestNode(curLayout.nodes, useAppStore.getState().view, lp);
              if (hit) {
                onNodePress(hit);
              } else {
                // 节点优先：节点的矩形面积大，先判它，边只吃剩下的空白区域
                const st = useAppStore.getState();
                const edgeId = hitTestEdge(curLayout.edges, st.view, lp);
                const ends = edgeId ? splitEdgeKey(edgeId) : null;
                if (ends) st.selectEdgeFromGraph(ends.source, ends.target, upEvent.shiftKey);
                else st.clearEdgeSelection();
              }
            }
          }
        },
      });
    });
  }, []);


  const hoverEnabled = !!layout && layout.edges.length <= MAX_HOVER_EDGES;
  useEffect(() => {
    hoverEnabledRef.current = hoverEnabled;
    if (!hoverEnabled) setHoverEdge(null);
  }, [hoverEnabled]);

  /**
   * hover 命中：原生 pointermove + rAF 节流。
   *
   * 只做两件事：改容器上的光标（命令式写 style，避免为了一根手指形状的变化整棵树重渲染）
   * 和更新 tooltip 状态。拖动中（suppressPress）不检测 —— 那一下是平移不是浏览；
   * 边数超过 MAX_HOVER_EDGES 时命中直接算 null，点击路径不受影响。
   */
  useEffect(() => {
    const el = asElement(containerRef);
    const compute = (): void => {
      hoverRaf.current = 0;
      const pt = hoverPending.current;
      if (!pt) return;
      const curLayout = layoutRef.current;
      let edgeHit: string | null = null;
      let pointer = false;
      if (curLayout) {
        const st = useAppStore.getState();
        if (hoverEnabledRef.current) edgeHit = hitTestEdge(curLayout.edges, st.view, pt);
        pointer = !!edgeHit || !!hitTestNode(curLayout.nodes, st.view, pt);
      }
      if (el) el.style.cursor = pointer ? 'pointer' : 'default';
      setHoverEdge((prev) => {
        if (!edgeHit) return prev === null ? prev : null;
        const same = prev && prev.id === edgeHit;
        const drifted = prev ? Math.abs(prev.x - pt.x) + Math.abs(prev.y - pt.y) > HOVER_MOVE_SLOP : true;
        return same && !drifted ? prev : { id: edgeHit, x: pt.x, y: pt.y };
      });
    };
    const offMove = subscribePointerMove(el, (e) => {
      hoverPending.current = localPoint(asElement(containerRef), e.clientX, e.clientY);
      if (suppressPress.current || hoverRaf.current) return;
      hoverRaf.current = requestAnimationFrame(compute);
    });
    const offLeave = subscribePointerLeave(el, () => {
      hoverPending.current = null;
      if (hoverRaf.current) {
        cancelAnimationFrame(hoverRaf.current);
        hoverRaf.current = 0;
      }
      if (el) el.style.cursor = 'default';
      setHoverEdge(null);
    });
    return () => {
      offMove();
      offLeave();
      if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = 0;
    };
  }, []);

  // 适应窗口：图变了 / fitNonce 变了才重算，用户手动平移不会被覆盖
  useEffect(() => {
    if (!layout) return;
    const prev = fittedFor.current;
    if (prev && prev.nonce === fitNonce && prev.w === layout.width && prev.h === layout.height) {
      return;
    }
    fittedFor.current = { nonce: fitNonce, w: layout.width, h: layout.height };
    const vp = viewportRef.current;
    useAppStore.getState().setView(fitTransform(layout.width, layout.height, vp.w, vp.h));
  }, [layout, fitNonce]);

  // 代码 -> 图：selection.source === 'code' 时把目标节点居中（scale 保持当前值）
  useEffect(() => {
    if (selection.source !== 'code') return;
    const id = selection.funcId;
    if (!id || !layout) return;
    if (centeredNonce.current === selection.nonce) return;
    centeredNonce.current = selection.nonce;
    const box = layout.nodes.get(id);
    if (!box) return;
    const st = useAppStore.getState();
    const vp = viewportRef.current;
    const t = centerTransform(box.cx, box.cy, vp.w, vp.h, st.view.scale);
    st.setView({ tx: t.tx, ty: t.ty, scale: st.view.scale });
  }, [selection.nonce, selection.source, selection.funcId, layout]);

  const onNodePress = (id: FuncId): void => {
    if (suppressPress.current) return;
    selectFromGraph(id);
  };

  const zoomBy = (factor: number): void => {
    const st = useAppStore.getState();
    const vp = viewportRef.current;
    st.setView(zoomAround(st.view, vp.w / 2, vp.h / 2, st.view.scale * factor));
  };

  const hasSelection = !!selection.funcId && nodeIndex.has(selection.funcId as FuncId);
  const large = !!scoped && isLarge(scoped);
  const busy = status === 'loading-wasm' || status === 'parsing';
  const selectedFunc = selection.funcId ? nodeIndex.get(selection.funcId) : undefined;
  const legendFiles = (fullGraph ?? scoped)?.files ?? [];

  const edgePaths: ReactNode[] = [];
  if (layout) {
    for (const e of layout.edges) {
      const selected = e.id === selectedEdgeId;
      const hovered = !!hoverEdge && e.id === hoverEdge.id;
      const adjacent = neighborEdges.has(e.id);
      const stroke = selected ? colors.selected : adjacent ? colors.neighbor : colors.edge;
      const opacity = hasSelection && !adjacent && !selected ? EDGE_DIM_OPACITY : 1;
      const strokeWidth = selected ? Math.max(e.strokeWidth, 2.6) : hovered ? e.strokeWidth + 1.2 : e.strokeWidth;
      edgePaths.push(
        <G key={e.id} testID={'graph-edge-' + e.id} opacity={opacity}>
          <Path d={e.d} stroke={stroke} strokeWidth={strokeWidth} fill="none" />
          <Path d={arrowHeadPath(e.arrow)} fill={stroke} stroke="none" />
          {e.weight > 1 ? (
            <SvgText
              x={e.mid.x}
              y={e.mid.y - 5}
              textAnchor="middle"
              fontSize={10}
              fontFamily={fonts.ui}
              fill={selected ? colors.selected : adjacent ? colors.neighbor : colors.faint}
            >
              {'\u00d7' + e.weight}
            </SvgText>
          ) : null}
        </G>
      );
    }
  }

  const nodeViews: ReactNode[] = [];
  if (layout && scoped) {
    for (const n of scoped.nodes) {
      const box = layout.nodes.get(n.id);
      if (!box) continue;
      nodeViews.push(
        <GraphNodeView
          key={n.id}
          func={n}
          box={box}
          colorIndex={colorIndexOf.get(n.file) ?? 0}
          selected={selection.funcId === n.id}
          neighbor={hasSelection && neighbors.has(n.id)}
          dimmed={hasSelection && selection.funcId !== n.id && !neighbors.has(n.id)}
          edgeEndpoint={edgeEndpoints.has(n.id)}
          showFile={layout.showFile}
        />
      );
    }
  }


  /** 端点标签：优先当前范围内的节点符号，被裁出范围时回退到全量图，再退化成原始 id */
  const funcLabel = (id: FuncId): string => {
    const f = nodeIndex.get(id) ?? fullGraph?.nodes.find((n) => n.id === id);
    return f ? nodeLabel(f) : id;
  };

  /** 底栏一行文本：A → B · 第 k/N 处 · file:line（只有 1 处调用时不显示序号） */
  const edgeInfo = (() => {
    if (!edgeSelection) return null;
    const site = sortedCallSites(findEdge(fullGraph, edgeSelection.source, edgeSelection.target))[
      edgeSelection.index
    ];
    const text = funcLabel(edgeSelection.source) + ' \u2192 ' + funcLabel(edgeSelection.target);
    if (!site) return text;
    const seq =
      edgeSelection.count > 1 ? '  \u00b7  ' + (edgeSelection.index + 1) + '/' + edgeSelection.count : '';
    return text + seq + '  \u00b7  ' + site.file + ':' + site.line;
  })();

  /** hover 提示：这根线可以点，以及点下去会落到哪一行 */
  const hoverInfo = (() => {
    if (!hoverEdge) return null;
    const ends = splitEdgeKey(hoverEdge.id);
    if (!ends) return null;
    const sites = sortedCallSites(findEdge(fullGraph, ends.source, ends.target));
    const first = sites[0];
    if (!first) return null;
    const label =
      funcLabel(ends.source) +
      ' \u2192 ' +
      funcLabel(ends.target) +
      (sites.length > 1
        ? '  \u00b7  ' + sites.length + ' call sites  \u00b7  first at line ' + first.line
        : '  \u00b7  line ' + first.line);
    const vp = viewportRef.current;
    return {
      text: label,
      left: Math.max(4, Math.min(vp.w - TIP_W - 4, hoverEdge.x + TIP_OFFSET)),
      top: Math.max(4, Math.min(vp.h - TIP_H - 4, hoverEdge.y + TIP_OFFSET)),
    };
  })();

  const transform = 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')';
  const empty = !scoped || scoped.nodes.length === 0;

  return (
    <View style={styles.container} testID="graph-pane">
      <View
        ref={containerRef}
        style={[styles.canvas, CURSOR_GRAB, NO_TOUCH]}
        onLayout={onContainerLayout}
        testID="graph-canvas"
      >
        {empty ? (
          <View style={styles.emptyWrap} testID="graph-empty">
            <Text style={styles.emptyTitle}>
              {'No call relationships to display'}
            </Text>
            <Text style={styles.emptyHint}>
              {
                'Upload .py files to see the call graph here.'
              }
            </Text>
          </View>
        ) : (
          <Svg width="100%" height="100%" testID="graph-svg">
            <G transform={transform}>
              {edgePaths}
              {nodeViews}
            </G>
          </Svg>
        )}

        <View style={styles.toolbar}>
          <Pressable
            testID="graph-zoom-in"
            style={styles.toolBtn}
            onPress={() => zoomBy(ZOOM_IN)}
            accessibilityLabel="zoom in"
          >
            <Text style={styles.toolBtnText}>{'+'}</Text>
          </Pressable>
          <Pressable
            testID="graph-zoom-out"
            style={styles.toolBtn}
            onPress={() => zoomBy(ZOOM_OUT)}
            accessibilityLabel="zoom out"
          >
            <Text style={styles.toolBtnText}>{'\u2212'}</Text>
          </Pressable>
          <Pressable
            testID="graph-fit"
            style={[styles.toolBtn, styles.toolBtnWide]}
            onPress={() => fitView()}
            accessibilityLabel="fit"
          >
            <Text style={styles.toolBtnText}>{'Fit View'}</Text>
          </Pressable>
          <Text style={styles.zoomLabel} testID="graph-zoom-label">
            {Math.round(view.scale * 100) + '%'}
          </Text>
        </View>

        {large ? (
          <View style={styles.hint} testID="graph-large-hint">
            <Text style={styles.hintText}>
              {'Too many nodes in current scope (' +
                (scoped ? scoped.nodes.length : 0) +
                '), try switching to "Neighborhood" or "This File" to narrow the scope'}
            </Text>
          </View>
        ) : null}

        {busy ? (
          <View style={styles.busy} testID="graph-busy">
            <Text style={styles.busyText}>
              {status === 'loading-wasm'
                ? 'Loading parser\u2026'
                : 'Parsing ' + progress.done + '/' + progress.total + ' \u2026'}
            </Text>
          </View>
        ) : null}

        {hoverInfo ? (
          <View
            style={[styles.tip, { left: hoverInfo.left, top: hoverInfo.top }]}
            testID="graph-edge-tooltip"
          >
            <Text style={styles.tipText} numberOfLines={1}>
              {hoverInfo.text}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.footer} testID="graph-footer">
        <View style={styles.legend} testID="graph-legend">
          {layout && layout.showFile
            ? legendFiles.slice(0, 8).map((f, i) => (
                <View key={f} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: fileColor(i) }]} />
                  <Text style={styles.legendText} numberOfLines={1}>
                    {f.split('/').pop() ?? f}
                  </Text>
                </View>
              ))
            : null}
        </View>
        {edgeInfo ? (
          <Text style={styles.edgeInfo} testID="graph-edge-info" numberOfLines={1}>
            {edgeInfo}
          </Text>
        ) : null}
        <Text style={styles.selInfo} testID="graph-selection-info" numberOfLines={1}>
          {selectedFunc
            ? nodeLabel(selectedFunc) +
              (selectedFunc.file ? '  \u00b7  ' + selectedFunc.file : '') +
              '  \u00b7  direct neighbors ' +
              neighbors.size
            : 'Click a node to locate code; scroll to zoom, drag to pan'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, overflow: 'hidden' },
  canvas: { flex: 1, position: 'relative' },
  // pointerEvents 走 style：RN 0.78+ / RNW 0.21 已废弃 prop 形式
  emptyWrap: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: { color: colors.text, fontFamily: fonts.ui, fontSize: 15, marginBottom: spacing.sm },
  emptyHint: { color: colors.dim, fontFamily: fonts.ui, fontSize: 12, textAlign: 'center' },
  toolbar: {
    pointerEvents: 'box-none',
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.overlay,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xs,
  },
  toolBtn: {
    minWidth: 28,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.panelAlt,
  },
  toolBtnWide: { minWidth: 74 },
  toolBtnText: { color: colors.text, fontFamily: fonts.ui, fontSize: 12 },
  zoomLabel: {
    color: colors.dim,
    fontFamily: fonts.mono,
    fontSize: 11,
    minWidth: 40,
    textAlign: 'center',
  },
  hint: {
    pointerEvents: 'none',
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: 140,
    backgroundColor: colors.overlay,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.warn,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  hintText: { color: colors.warn, fontFamily: fonts.ui, fontSize: 11 },
  busy: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  busyText: { color: colors.text, fontFamily: fonts.ui, fontSize: 13 },
  tip: {
    pointerEvents: 'none',
    position: 'absolute',
    width: TIP_W,
    height: TIP_H,
    justifyContent: 'center',
    backgroundColor: colors.tooltipBg,
    borderWidth: 1,
    borderColor: colors.selected,
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
  },
  tipText: { color: colors.tooltipText, fontFamily: fonts.mono, fontSize: 11 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.panel,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 28,
  },
  legend: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.dim, fontFamily: fonts.ui, fontSize: 11 },
  selInfo: {
    color: colors.dim,
    fontFamily: fonts.ui,
    fontSize: 11,
    flexShrink: 1,
    marginLeft: 'auto',
  },
  edgeInfo: {
    color: colors.selected,
    fontFamily: fonts.mono,
    fontSize: 11,
    flexShrink: 1,
  },
});
