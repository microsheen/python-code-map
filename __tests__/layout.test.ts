/**
 * dagre 布局包装的纯函数部分：尺寸估算、路径生成、视口变换，以及 LR 单调性。
 */
import {
  ARROW_HALF_W,
  ARROW_SIZE,
  CHAR_W,
  MAX_NODE_W,
  MAX_SCALE,
  MIN_NODE_W,
  MIN_SCALE,
  NODE_H_DOUBLE,
  NODE_H_SINGLE,
  arrowHeadPath,
  centerTransform,
  clampScale,
  edgeStrokeWidth,
  fileLabel,
  fitTransform,
  layoutGraph,
  nodeLabel,
  nodeSize,
  pointsToPath,
  selfLoopTip,
  tipFromPoints,
} from '../src/graph/layout';
import type { NodeBox } from '../src/graph/layout';
import { makeFuncId } from '../src/parser/symbols';
import { edge, func, graphOf } from './helpers/synth';

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
