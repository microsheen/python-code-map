/**
 * GraphPane 里的纯函数与常量。
 *
 * 这里不渲染组件（组件行为在 appFlow.test.tsx 里覆盖），只锁住几件容易在
 * 重构时被无声改坏的事：滚轮灵敏度、以光标为锚点的缩放不变量、标签截断、
 * 以及"选中时非邻居只压暗不隐藏"的对比度下限。
 */
import {
  DEFAULT_VIEWPORT,
  DIM_OPACITY,
  DRAG_SLOP,
  EDGE_DIM_OPACITY,
  NODE_RADIUS,
  WHEEL_LINE_FACTOR,
  WHEEL_PIXEL_FACTOR,
  ZOOM_IN,
  ZOOM_OUT,
  fitLabel,
  hitTestNode,
  wheelScaleFactor,
  zoomAround,
} from '../src/components/GraphPane';
import type { ViewBox } from '../src/components/GraphPane';
import type { FuncId } from '../src/parser/types';
import { CHAR_W, MAX_SCALE, MIN_SCALE } from '../src/graph/layout';
import type { NodeBox } from '../src/graph/layout';

describe('GraphPane 常量', () => {
  it('jsdom 不触发 onLayout，需要兜底视口', () => {
    expect(DEFAULT_VIEWPORT.w).toBeGreaterThan(0);
    expect(DEFAULT_VIEWPORT.h).toBeGreaterThan(0);
  });

  it('缩放步进互为倒数附近，且拖拽阈值 / 角标半径为正', () => {
    expect(ZOOM_IN).toBeGreaterThan(1);
    expect(ZOOM_OUT).toBeLessThan(1);
    expect(ZOOM_IN * ZOOM_OUT).toBeCloseTo(1, 5);
    expect(DRAG_SLOP).toBeGreaterThan(0);
    expect(NODE_RADIUS).toBeGreaterThan(0);
  });

  it('压暗只降不隐：非邻居节点仍读得清，连边颜色不双重压暗', () => {
    // 0.5 是节点文字对比度约 4:1 的经验下限，低于它"其他函数太暗看不清"就会复发
    expect(DIM_OPACITY).toBeGreaterThanOrEqual(0.5);
    expect(DIM_OPACITY).toBeLessThan(1);
    // 边不再用 edgeDim 颜色，只靠透明度区分，所以 EDGE_DIM_OPACITY 可以 >= DIM_OPACITY
    expect(EDGE_DIM_OPACITY).toBeGreaterThan(0);
    expect(EDGE_DIM_OPACITY).toBeLessThan(1);
  });

  it('两种 deltaMode 的灵敏度系数：按行远大于按像素', () => {
    expect(WHEEL_LINE_FACTOR).toBe(0.05);
    expect(WHEEL_PIXEL_FACTOR).toBe(0.0016);
    expect(WHEEL_LINE_FACTOR).toBeGreaterThan(WHEEL_PIXEL_FACTOR);
  });
});

describe('wheelScaleFactor', () => {
  it('向上滚（deltaY<0）放大，向下滚缩小', () => {
    expect(wheelScaleFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelScaleFactor(100, 0)).toBeLessThan(1);
  });

  it('deltaY=0 时不缩放', () => {
    expect(wheelScaleFactor(0, 0)).toBe(1);
    expect(wheelScaleFactor(0, 1)).toBe(1);
  });

  it('deltaMode=1 按行，deltaMode=0 按像素', () => {
    expect(wheelScaleFactor(-3, 1)).toBeCloseTo(Math.exp(3 * WHEEL_LINE_FACTOR), 10);
    expect(wheelScaleFactor(-120, 0)).toBeCloseTo(Math.exp(120 * WHEEL_PIXEL_FACTOR), 10);
  });

  it('同样的 deltaY 下按行模式比按像素模式更激进', () => {
    expect(wheelScaleFactor(-1, 1)).toBeGreaterThan(wheelScaleFactor(-1, 0));
  });

  it('未知 deltaMode 退化为按像素', () => {
    expect(wheelScaleFactor(-50, 2)).toBeCloseTo(wheelScaleFactor(-50, 0), 10);
  });
});

describe('zoomAround', () => {
  const view: ViewBox = { tx: 40, ty: -20, scale: 1.5 };

  it('缩放不变时返回同一个引用（避免无谓的重渲染）', () => {
    expect(zoomAround(view, 100, 100, 1.5)).toBe(view);
  });

  it('锚点的世界坐标在缩放前后不变', () => {
    const ax = 300;
    const ay = 200;
    const wx = (ax - view.tx) / view.scale;
    const wy = (ay - view.ty) / view.scale;
    for (const next of [0.3, 0.8, 1, 2.5]) {
      const r = zoomAround(view, ax, ay, next);
      expect((ax - r.tx) / r.scale).toBeCloseTo(wx, 8);
      expect((ay - r.ty) / r.scale).toBeCloseTo(wy, 8);
    }
  });

  it('放大后 tx/ty 朝锚点方向移动', () => {
    const r = zoomAround(view, 300, 200, 2);
    expect(r.scale).toBe(2);
    expect(r.tx).toBeLessThan(view.tx);
  });

  it('目标缩放被 clamp 到 [MIN_SCALE, MAX_SCALE]', () => {
    expect(zoomAround(view, 10, 10, 99).scale).toBe(MAX_SCALE);
    expect(zoomAround(view, 10, 10, -5).scale).toBe(MIN_SCALE);
  });

  it('已经在上限时继续放大 -> 原样返回（同引用）', () => {
    const atMax: ViewBox = { tx: 0, ty: 0, scale: MAX_SCALE };
    expect(zoomAround(atMax, 50, 50, MAX_SCALE * 2)).toBe(atMax);
  });

  it('锚点在原点时只改 scale 与平移的比例关系', () => {
    const v: ViewBox = { tx: 0, ty: 0, scale: 1 };
    const r = zoomAround(v, 0, 0, 2);
    expect(r).toEqual({ tx: 0, ty: 0, scale: 2 });
  });

  it('多次连续缩放等价于一次到位（锚点不动）', () => {
    let cur: ViewBox = { tx: 0, ty: 0, scale: 1 };
    const ax = 120;
    const ay = 80;
    for (let i = 0; i < 5; i++) cur = zoomAround(cur, ax, ay, cur.scale * 1.1);
    const once = zoomAround({ tx: 0, ty: 0, scale: 1 }, ax, ay, Math.pow(1.1, 5));
    expect(cur.tx).toBeCloseTo(once.tx, 8);
    expect(cur.ty).toBeCloseTo(once.ty, 8);
    expect(cur.scale).toBeCloseTo(once.scale, 8);
  });
});

describe('hitTestNode', () => {
  const box = (x: number, y: number, w: number, h: number): NodeBox => ({
    x,
    y,
    w,
    h,
    cx: x + w / 2,
    cy: y + h / 2,
  });
  const nodes = new Map<FuncId, NodeBox>([
    ['a.py::alpha', box(100, 40, 120, 34)],
    ['b.py::beta', box(100, 120, 120, 34)],
  ]);
  const identity = { tx: 0, ty: 0, scale: 1 };

  it('命中矩形内部返回对应节点 id', () => {
    expect(hitTestNode(nodes, identity, { x: 150, y: 55 })).toBe('a.py::alpha');
    expect(hitTestNode(nodes, identity, { x: 150, y: 135 })).toBe('b.py::beta');
  });

  it('四条边都算命中（否则缩小后边缘点击会漏）', () => {
    const n: NodeBox = nodes.get('a.py::alpha')!;
    expect(hitTestNode(nodes, identity, { x: n.x, y: n.cy })).toBe('a.py::alpha');
    expect(hitTestNode(nodes, identity, { x: n.x + n.w, y: n.cy })).toBe('a.py::alpha');
    expect(hitTestNode(nodes, identity, { x: n.cx, y: n.y })).toBe('a.py::alpha');
    expect(hitTestNode(nodes, identity, { x: n.cx, y: n.y + n.h })).toBe('a.py::alpha');
  });

  it('矩形外返回 null', () => {
    expect(hitTestNode(nodes, identity, { x: 99, y: 55 })).toBeNull();
    expect(hitTestNode(nodes, identity, { x: 150, y: 75 })).toBeNull();
    expect(hitTestNode(new Map(), identity, { x: 0, y: 0 })).toBeNull();
  });

  it('先把容器坐标按 view 逆变换成世界坐标：平移与缩放都跟随', () => {
    const view = { tx: -30, ty: 12, scale: 2 };
    const n = nodes.get('b.py::beta')!;
    // 世界点 -> 容器点的正向换算，再喂给 hitTestNode 应当还原
    const local = { x: view.tx + n.cx * view.scale, y: view.ty + n.cy * view.scale };
    expect(hitTestNode(nodes, view, local)).toBe('b.py::beta');
    // 同一个容器坐标在 identity 下不再是那个节点
    expect(hitTestNode(nodes, identity, local)).toBeNull();
  });

  it('缩放后节点在屏幕上变大，原来的空白点也会命中', () => {
    const zoomed = { tx: 0, ty: 0, scale: 3 };
    // alpha 右下角世界坐标 (220, 74) -> 容器 (660, 222)
    expect(hitTestNode(nodes, zoomed, { x: 660, y: 222 })).toBe('a.py::alpha');
  });
});


describe('fitLabel', () => {
  it('短标签原样返回', () => {
    expect(fitLabel('alpha', 200)).toBe('alpha');
  });

  it('超长标签截断并加省略号，长度不超过上限', () => {
    const label = 'SomeVeryLongClassName.some_equally_long_method_name';
    const out = fitLabel(label, 120);
    const max = Math.max(6, Math.floor((120 - 16) / CHAR_W));
    expect(out.endsWith('\u2026')).toBe(true);
    expect(out.length).toBe(max);
    expect(label.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('窄到极限时至少保留 6 个字符', () => {
    const out = fitLabel('abcdefghijklmnop', 10);
    expect(out.length).toBe(6);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('刚好等于上限时不截断', () => {
    const boxW = 16 + 10 * CHAR_W;
    expect(fitLabel('0123456789', boxW)).toBe('0123456789');
    expect(fitLabel('01234567890', boxW).endsWith('\u2026')).toBe(true);
  });

  it('空串原样返回', () => {
    expect(fitLabel('', 200)).toBe('');
  });
});
