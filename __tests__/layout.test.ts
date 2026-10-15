/**
 * dagre 布局包装的纯函数部分：尺寸估算、路径生成、视口变换，以及 LR 单调性。
 */
import {
  ARROW_HALF_W,
  ARROW_SIZE,
  CHAR_W,
  CUBIC_SAMPLES,
  MAX_NODE_W,
  MAX_SCALE,
  MIN_NODE_W,
  MIN_SCALE,
  NODE_H_DOUBLE,
  NODE_H_SINGLE,
  arrowHeadPath,
  bboxOf,
  centerTransform,
  clampScale,
  edgeStrokeWidth,
  fileLabel,
  fitTransform,
  layoutGraph,
  nodeLabel,
  nodeSize,
  pointsToPath,
  QUAD_SAMPLES,
  sampleCubic,
  sampleQuadratic,
  sampleSmoothedPolyline,
  selfLoopCurve,
  selfLoopTip,
  tipFromPoints,
} from '../src/graph/layout';
import type { NodeBox } from '../src/graph/layout';
import { makeFuncId } from '../src/parser/symbols';
import { callSite, edge, func, graphOf } from './helpers/synth';

const F = 'pkg/mod.py';
const id = (q: string): string => makeFuncId(F, q);

function box(x: number, y: number, w: number, h: number): NodeBox {
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

describe('nodeLabel / fileLabel', () => {
  it('标签取限定名，文件名取最后两段', () => {
    expect(nodeLabel(func(F, 'Cls.run'))).toBe('Cls.run');
    expect(fileLabel(func('pkg/mod.py', 'run'))).toBe('pkg/mod.py');
    expect(fileLabel(func('a/b/c.py', 'run'))).toBe('b/c.py');
    expect(fileLabel(func('mod.py', 'run'))).toBe('mod.py');
    expect(fileLabel(func('', 'run'))).toBe('');
  });
});

describe('nodeSize', () => {
  it('短标签被 MIN_NODE_W 兜住，单行高', () => {
    const s = nodeSize(func(F, 'a'), false);
    expect(s.w).toBe(MIN_NODE_W);
    expect(s.h).toBe(NODE_H_SINGLE);
  });

  it('超长标签被 MAX_NODE_W 截断', () => {
    const s = nodeSize(func(F, 'x'.repeat(120)), false);
    expect(s.w).toBe(MAX_NODE_W);
  });

  it('showFile 且有文件名副标签时升高一行', () => {
    expect(nodeSize(func(F, 'run'), true).h).toBe(NODE_H_DOUBLE);
    // 没有文件名（external 合成节点）时即使 showFile 也保持单行
    expect(nodeSize(func('', 'builtins'), true).h).toBe(NODE_H_SINGLE);
  });

  it('宽度按字符数线性增长', () => {
    const label = 'f'.repeat(20);
    const expected = Math.round(20 * CHAR_W + 28);
    expect(nodeSize(func(F, label), false).w).toBe(expected);
  });
});

describe('edgeStrokeWidth', () => {
  it('对数增长并 clamp 到 [1, 4]', () => {
    expect(edgeStrokeWidth(0)).toBe(1);
    expect(edgeStrokeWidth(1)).toBe(2);
    expect(edgeStrokeWidth(2)).toBe(2.6);
    expect(edgeStrokeWidth(7)).toBe(4);
    expect(edgeStrokeWidth(500)).toBe(4);
    expect(edgeStrokeWidth(-3)).toBe(1);
  });
});

describe('arrowHeadPath / tipFromPoints / selfLoopTip', () => {
  it('向右的箭头三点闭合', () => {
    const d = arrowHeadPath({ x: 10, y: 0, angle: 0 });
    expect(d).toBe('M 10 0 L 1 ' + ARROW_HALF_W + ' L 1 -' + ARROW_HALF_W + ' Z');
    expect(ARROW_SIZE).toBe(9);
  });

  it('自定义尺寸生效', () => {
    expect(arrowHeadPath({ x: 0, y: 0, angle: 0 }, 4, 2)).toBe('M 0 0 L -4 2 L -4 -2 Z');
  });

  it('从折线末两点推方向', () => {
    expect(tipFromPoints([{ x: 0, y: 0 }, { x: 5, y: 0 }])).toEqual({ x: 5, y: 0, angle: 0 });
    expect(tipFromPoints([{ x: 0, y: 0 }, { x: 0, y: 5 }])).toEqual({ x: 0, y: 5, angle: 90 });
    // 只有一个点时兜底成"向右"
    expect(tipFromPoints([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4, angle: 0 });
    // 末两点重合时同样兜底
    expect(tipFromPoints([{ x: 1, y: 1 }, { x: 1, y: 1 }]).angle).toBe(0);
  });

  it('自环箭头落在节点右边框上', () => {
    const b = box(10, 20, 100, 34);
    const tip = selfLoopTip(b);
    expect(tip.x).toBe(110);
    expect(tip.y).toBeCloseTo(20 + 34 * 0.68, 6);
    expect(tip.angle).toBeLessThan(0);
    expect(tip.angle).toBeGreaterThan(-180);
  });
});

describe('pointsToPath', () => {
  it('空 / 单点 / 两点 / 多点', () => {
    expect(pointsToPath([])).toBe('');
    expect(pointsToPath([{ x: 1, y: 2 }])).toBe('M 1 2');
    expect(pointsToPath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe('M 1 2 L 3 4');
    expect(
      pointsToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }]),
    ).toBe('M 0 0 Q 10 0 15 5 L 20 10');
  });

  it('坐标保留两位小数', () => {
    expect(pointsToPath([{ x: 1.23456, y: 2 }])).toBe('M 1.23 2');
  });
});

describe('layoutGraph', () => {
  it('rankdir=LR：调用方的中心 x 严格小于被调方', () => {
    const nodes = [
      func(F, 'a', { defLine: 1 }),
      func(F, 'b', { defLine: 5 }),
      func(F, 'c', { defLine: 9 }),
    ];
    const g = graphOf(nodes, [edge(id('a'), id('b')), edge(id('b'), id('c'))]);
    const l = layoutGraph(g);
    const a = l.nodes.get(id('a'));
    const b = l.nodes.get(id('b'));
    const c = l.nodes.get(id('c'));
    expect(a !== undefined && b !== undefined && a.cx < b.cx).toBe(true);
    expect(b !== undefined && c !== undefined && b.cx < c.cx).toBe(true);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it('单文件时 showFile=false，多文件时为 true', () => {
    const one = layoutGraph(graphOf([func(F, 'a')], []));
    expect(one.showFile).toBe(false);
    const two = layoutGraph(
      graphOf([func(F, 'a'), func('other.py', 'b')], [edge(id('a'), makeFuncId('other.py', 'b'))]),
    );
    expect(two.showFile).toBe(true);
  });

  it('自环边走贝塞尔路径，普通边走折线', () => {
    const self = layoutGraph(graphOf([func(F, 'rec')], [edge(id('rec'), id('rec'))]));
    expect(self.edges).toHaveLength(1);
    expect(self.edges[0]?.selfLoop).toBe(true);
    expect(self.edges[0]?.d).toContain('C ');
    const plain = layoutGraph(graphOf([func(F, 'a'), func(F, 'b')], [edge(id('a'), id('b'))]));
    expect(plain.edges[0]?.selfLoop).toBe(false);
    expect(plain.edges[0]?.d.startsWith('M ')).toBe(true);
    expect(plain.edges[0]?.arrow.x).toBeGreaterThan(0);
  });

  it('两端缺一的边被跳过，不会崩', () => {
    const g = graphOf([func(F, 'a')], [edge(id('a'), makeFuncId(F, 'ghost'))]);
    const l = layoutGraph(g);
    expect(l.edges).toHaveLength(0);
    expect(l.nodes.size).toBe(1);
  });

  it('空图返回 1x1 而不是 0（避免除零）', () => {
    const l = layoutGraph(graphOf([], []));
    expect(l.width).toBeGreaterThanOrEqual(1);
    expect(l.height).toBeGreaterThanOrEqual(1);
    expect(l.nodes.size).toBe(0);
  });

  it('节点框的 x/y 由中心点减去半宽半高得到', () => {
    const l = layoutGraph(graphOf([func(F, 'a')], []));
    const b = l.nodes.get(id('a'));
    expect(b).toBeDefined();
    expect(b?.x).toBeCloseTo((b?.cx ?? 0) - (b?.w ?? 0) / 2, 6);
    expect(b?.y).toBeCloseTo((b?.cy ?? 0) - (b?.h ?? 0) / 2, 6);
  });
});

describe('视口变换', () => {
  it('centerTransform 把世界坐标点放到视口中心', () => {
    expect(centerTransform(100, 50, 800, 600, 2)).toEqual({ tx: 200, ty: 200 });
    expect(centerTransform(0, 0, 800, 600, 1)).toEqual({ tx: 400, ty: 300 });
  });

  it('fitTransform 取长宽比的较小值并居中', () => {
    expect(fitTransform(1000, 500, 500, 500)).toEqual({ tx: 0, ty: 125, scale: 0.5 });
  });

  it('fitTransform 受 min/max 约束', () => {
    expect(fitTransform(10, 10, 1000, 1000).scale).toBe(1.2);
    expect(fitTransform(100000, 100000, 100, 100).scale).toBe(0.3);
  });

  it('视口或内容尺寸非正时退化为单位变换', () => {
    expect(fitTransform(0, 0, 0, 0)).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(fitTransform(100, 100, 0, 500)).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it('clampScale 限制在 [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(MIN_SCALE).toBe(0.3);
    expect(MAX_SCALE).toBe(2.5);
  });
});

describe('边上的密采样折线 points / bbox（点中一条线靠它）', () => {
  const ab = callSite({ file: F, line: 3, column: 4, text: 'b', caller: id('A.a'), target: id('B.b') });
  const bb = callSite({ file: F, line: 10, column: 4, text: 'b', caller: id('B.b'), target: id('B.b') });
  const laid = layoutGraph(
    graphOf([func(F, 'A.a', { defLine: 1 }), func(F, 'B.b', { defLine: 9 })], [
      edge(id('A.a'), id('B.b'), [ab]),
      edge(id('B.b'), id('B.b'), [bb]),
    ]),
  );
  const plain = laid.edges.find((e) => !e.selfLoop);
  const loop = laid.edges.find((e) => e.selfLoop);

  it('d 字符串逐字不变：这次重构只加字段，没有改画法', () => {
    expect(plain?.d).toBe('M 132 45 Q 180 45 204 45 L 228 45');
    expect(loop?.d).toBe('M 332 38.88 C 378 22 378 68 332 51.12');
  });

  it('普通边：采样首点 = M 起点，末点 = L 终点', () => {
    const pts = plain?.points ?? [];
    expect(pts[0]).toEqual({ x: 132, y: 45 });
    const last = pts[pts.length - 1];
    expect(last?.x).toBeCloseTo(228, 6);
    expect(last?.y).toBeCloseTo(45, 6);
  });

  it('自环：采样首末点与 path 的两端一致（画的是同一条曲线）', () => {
    const curve = selfLoopCurve(laid.nodes.get(id('B.b')) ?? { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 });
    const pts = loop?.points ?? [];
    expect(pts[0]).toEqual(curve.p0);
    const last = pts[pts.length - 1];
    expect(last?.x).toBeCloseTo(curve.p1.x, 6);
    expect(last?.y).toBeCloseTo(curve.p1.y, 6);
  });

  it('bbox 包住全部采样点，且鼓包在节点右侧', () => {
    for (const e of laid.edges) {
      const b = e.bbox;
      for (const pt of e.points) {
        expect(pt.x).toBeGreaterThanOrEqual(b.minX);
        expect(pt.x).toBeLessThanOrEqual(b.maxX);
        expect(pt.y).toBeGreaterThanOrEqual(b.minY);
        expect(pt.y).toBeLessThanOrEqual(b.maxY);
      }
    }
    const lb = loop?.bbox;
    expect(lb?.maxX).toBeGreaterThan((laid.nodes.get(id('B.b'))?.x ?? 0) + (laid.nodes.get(id('B.b'))?.w ?? 0));
  });

  it('每段曲线的细分密度足够：命中容差 7px 时不会漏掉鼓包', () => {
    expect((loop?.points ?? []).length).toBe(CUBIC_SAMPLES + 1);
    expect((plain?.points ?? []).length).toBe(QUAD_SAMPLES + 3);
  });
});

describe('sampleSmoothedPolyline / sampleQuadratic / sampleCubic / bboxOf', () => {
  it('空数组 -> 空；单点 -> 两个重合点（零长线段也算得出距离）', () => {
    expect(sampleSmoothedPolyline([])).toEqual([]);
    expect(sampleSmoothedPolyline([{ x: 1, y: 2 }])).toEqual([
      { x: 1, y: 2 },
      { x: 1, y: 2 },
    ]);
  });

  it('两点是直线：补一个中点，起止不变', () => {
    const out = sampleSmoothedPolyline([{ x: 0, y: 0 }, { x: 10, y: 4 }]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[1]).toEqual({ x: 5, y: 2 });
    expect(out[2]).toEqual({ x: 10, y: 4 });
  });

  it('>=3 点保留起点与终点，中间每段一条二次曲线', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }, { x: 30, y: 15 }];
    const out = sampleSmoothedPolyline(pts);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[3]);
    expect(out).toHaveLength(1 + QUAD_SAMPLES * (pts.length - 2) + 2);
  });

  it('二次曲线：不含起点、含终点；t=0.5 落在贝塞尔公式上', () => {
    const out = sampleQuadratic({ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 20, y: 0 });
    expect(out).toHaveLength(QUAD_SAMPLES);
    expect(out[out.length - 1]).toEqual({ x: 20, y: 0 });
    const mid = sampleQuadratic({ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 20, y: 0 }, 2)[0];
    expect(mid?.x).toBeCloseTo(10, 6);
    expect(mid?.y).toBeCloseTo(15, 6);
  });

  it('三次曲线：不含起点、含终点，中点符合公式', () => {
    const out = sampleCubic({ x: 0, y: 0 }, { x: 0, y: 12 }, { x: 24, y: 12 }, { x: 24, y: 0 });
    expect(out).toHaveLength(CUBIC_SAMPLES);
    expect(out[out.length - 1]).toEqual({ x: 24, y: 0 });
    const mid = sampleCubic({ x: 0, y: 0 }, { x: 0, y: 12 }, { x: 24, y: 12 }, { x: 24, y: 0 }, 2)[0];
    expect(mid?.x).toBeCloseTo(12, 6);
    expect(mid?.y).toBeCloseTo(9, 6);
  });

  it('bboxOf：空点集退化为零框，否则给出外接框', () => {
    expect(bboxOf([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(bboxOf([{ x: 3, y: 9 }, { x: -2, y: 4 }])).toEqual({ minX: -2, minY: 4, maxX: 3, maxY: 9 });
  });
});
