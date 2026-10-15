/**
 * 端到端组件测试：验证用户提出的两条核心验收。
 *
 *   1. 点击图中的函数 -> 左侧自动切到该文件、定位到 def 行、高亮函数体
 *   2. 点击代码中的函数 -> 右侧自动把该节点居中并高亮
 *
 * 环境说明：jest.config.js 用的是 jest-expo/web 预设，即 jsdom + `react-native` 别名到
 * `react-native-web`，所以顶栏与代码区用 @testing-library/react 的 fireEvent.click（真实
 * DOM 事件），而不是 @testing-library/react-native 的 fireEvent.press —— 后者在 RNW 下会
 * 因为 "Text strings must be rendered within a <Text>" 不变量直接炸掉。
 *
 * react-native-svg 被打桩成 RN 基础组件：只保留 testID / children，丢掉全部 SVG 几何属性，
 * 避免 DOM 未知属性告警。代价是 jsdom 里的节点方块没有尺寸，于是"点图上的节点"必须走
 * helpers/graphTap：按产品实现的真实事件路径（容器 pointerdown + 抬起时几何 hit-test）
 * 把节点中心换算成容器坐标再点，fireEvent.click(testID) 是点不中的。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppRoot } from '../src/components/AppRoot';
import { CodeRow, FLASH_MS } from '../src/components/CodePane/CodeView';
import { DEFAULT_VIEWPORT, DRAG_SLOP } from '../src/components/GraphPane';
import { layoutGraph } from '../src/graph/layout';
import {
  ALL_SCOPE,
  applyScope,
  fileScope,
  neighborhoodScope,
  scopeContains,
} from '../src/graph/scope';
import type { PythonParser } from '../src/parser/treeSitter';
import { DEFAULT_SPLIT, IDENTITY_VIEW, NO_SELECTION, useAppStore } from '../src/state/store';
import {
  dragGraph,
  edgeClientPoint,
  nodeClientPoint,
  tapGraphNode,
  tapGraphEdge,
  tapPoint,
} from './helpers/graphTap';
import {
  A_PATH,
  B_PATH,
  ID_ALPHA,
  ID_BETA,
  ID_CALLEE,
  ID_CALLER,
  ID_GAMMA,
  ID_INDIRECT,
  M_PATH,
  N_PATH,
  bigProject,
  multiCallProject,
  sampleProject,
  type SampleProject,
} from './helpers/sampleProject';
import { func } from './helpers/synth';

jest.mock('react-native-svg', () => {
  const RN = require('react-native');
  const React = require('react');
  const keep = (props: Record<string, unknown>) => ({
    testID: props.testID,
    children: props.children,
  });
  const G = (props: Record<string, unknown>) =>
    typeof props.onPress === 'function'
      ? React.createElement(
          RN.Pressable,
          { testID: props.testID, onPress: props.onPress },
          props.children
        )
      : React.createElement(RN.View, keep(props));
  const SvgText = (props: Record<string, unknown>) => React.createElement(RN.Text, keep(props));
  const Shape = (props: Record<string, unknown>) => React.createElement(RN.View, keep(props));
  const Svg = (props: Record<string, unknown>) =>
    React.createElement(RN.View, { ...keep(props), style: { width: 800, height: 600 } });
  return {
    __esModule: true,
    default: Svg,
    G,
    Rect: Shape,
    Path: Shape,
    Circle: Shape,
    Marker: Shape,
    Text: SvgText,
  };
});

/** 解析器在这些测试里不会被用到：store 已经预置好分析结果。 */
const NULL_PARSER: PythonParser = { parse: () => null, dispose: () => {} };

function preset(p: SampleProject, activeFile?: string): void {
  useAppStore.setState(
    {
      files: p.files,
      analyses: p.analyses,
      highlights: p.highlights,
      graph: p.graph,
      status: 'ready',
      error: null,
      warnings: [],
      progress: { done: p.files.length, total: p.files.length },
      activeFile: activeFile ?? p.files[0]?.path ?? null,
      selection: NO_SELECTION,
      scope: ALL_SCOPE,
      splitRatio: DEFAULT_SPLIT,
      view: IDENTITY_VIEW,
      fitNonce: 0,
      parser: NULL_PARSER,
    }
    // 注意：不能用 replace=true，否则 store 里的 action（setView/reset/...）会被一起抹掉
  );
}

function clickTestId(id: string): void {
  fireEvent.click(screen.getByTestId(id));
}

/** 当前 store 的 view 把哪个世界坐标点放到了视口中心。 */
function centeredWorldPoint(): { x: number; y: number } {
  const v = useAppStore.getState().view;
  return {
    x: (DEFAULT_VIEWPORT.w / 2 - v.tx) / v.scale,
    y: (DEFAULT_VIEWPORT.h / 2 - v.ty) / v.scale,
  };
}

afterEach(async () => {
    cleanup();
    await useAppStore.getState().reset();
  })

describe('验收 1：图 -> 代码', () => {
  it('点击图中节点：selection 变成 graph 来源，nonce 自增', () => {
    preset(sampleProject());
    render(<AppRoot />);

    tapGraphNode(ID_ALPHA);

    const sel = useAppStore.getState().selection;
    expect(sel.funcId).toBe(ID_ALPHA);
    expect(sel.source).toBe('graph');
    expect(sel.nonce).toBe(1);
  });

  it('拖动超过阈值只平移视图：不能顺手选中节点（图 -> 代码 的误触防护）', () => {
    preset(sampleProject());
    render(<AppRoot />);

    const start = nodeClientPoint(ID_BETA);
    const before = useAppStore.getState().view;

    dragGraph(start, DRAG_SLOP + 20, 0);

    const st = useAppStore.getState();
    expect(st.selection.funcId).toBeNull();
    expect(st.view.tx).toBeCloseTo(before.tx + DRAG_SLOP + 20, 6);
    expect(st.view.ty).toBeCloseTo(before.ty, 6);
    // 位移超过阈值但没点中：scale 不该被 setView 的部分更新丢掉
    expect(st.view.scale).toBe(before.scale);
  });

  it('阈值内的小抖动仍算点击', () => {
    preset(sampleProject());
    render(<AppRoot />);

    const start = nodeClientPoint(ID_BETA);
    dragGraph(start, 1, 1);

    expect(useAppStore.getState().selection.funcId).toBe(ID_BETA);
  });

  it('点击另一个文件里的节点：左侧自动切换文件并画出函数体高亮带', () => {
    preset(sampleProject(), A_PATH);
    render(<AppRoot />);

    // 前置：当前显示的是 a.py（第 1 行是 "import b"，没有 from）
    expect(screen.getByTestId('code-line-1').textContent ?? '').not.toContain('from');

    tapGraphNode(ID_GAMMA);

    const st = useAppStore.getState();
    expect(st.activeFile).toBe(B_PATH);
    expect(st.selection).toMatchObject({ funcId: ID_GAMMA, source: 'graph', nonce: 1 });

    // 左侧内容确实换成了 b.py（第 1 行是 "from a import alpha"）
    expect(screen.getByTestId('code-line-1').textContent ?? '').toContain('from');
    // 函数体高亮带存在（startLine..endLine）
    expect(screen.queryByTestId('code-selection-band')).not.toBeNull();
  });

  it('跨文件定位时也会画 1.2s 闪烁带（切文件的复位效果不能把它抹掉）', () => {
    preset(sampleProject(), A_PATH);
    render(<AppRoot />);
    expect(screen.queryByTestId('code-flash')).toBeNull();

    tapGraphNode(ID_GAMMA); // gamma 在 b.py，属于跨文件定位

    expect(screen.queryByTestId('code-flash')).not.toBeNull();
  });

  it('同文件定位同样会闪烁', () => {
    preset(sampleProject(), A_PATH);
    render(<AppRoot />);

    tapGraphNode(ID_BETA); // beta 也在 a.py

    expect(useAppStore.getState().activeFile).toBe(A_PATH);
    expect(screen.queryByTestId('code-flash')).not.toBeNull();
  });

  it('代码 -> 图 的选择不触发闪烁（闪烁只服务于图 -> 代码定位）', () => {
    preset(sampleProject());
    render(<AppRoot />);

    clickTestId('code-token-def-3');

    expect(useAppStore.getState().selection.source).toBe('code');
    expect(screen.queryByTestId('code-flash')).toBeNull();
  });
  it('闪烁层在 FLASH_MS 之后被摘掉', () => {
    jest.useFakeTimers();
    try {
      preset(sampleProject(), A_PATH);
      render(<AppRoot />);

      tapGraphNode(ID_BETA);
      expect(screen.queryByTestId('code-flash')).not.toBeNull();

      act(() => {
        jest.advanceTimersByTime(FLASH_MS);
      });
      expect(screen.queryByTestId('code-flash')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
  it('重复点击同一个节点：funcId 不变但 nonce 继续自增，定位可重复触发', () => {
    preset(sampleProject());
    render(<AppRoot />);

    tapGraphNode(ID_BETA);
    tapGraphNode(ID_BETA);
    tapGraphNode(ID_BETA);

    const sel = useAppStore.getState().selection;
    expect(sel.funcId).toBe(ID_BETA);
    expect(sel.nonce).toBe(3);
  });
});

describe('验收 2：代码 -> 图', () => {
  it('点击代码里的函数名：selection 变成 code 来源，且该节点被居中', () => {
    preset(sampleProject());
    render(<AppRoot />);

    // a.py 第 3 行 "def alpha():" 的函数名 token
    clickTestId('code-token-def-3');

    const st = useAppStore.getState();
    expect(st.selection.funcId).toBe(ID_ALPHA);
    expect(st.selection.source).toBe('code');
    expect(st.selection.nonce).toBe(1);

    // 右侧把 alpha 节点移到了视口中心
    const scoped = applyScope(st.graph!, st.scope);
    const box = layoutGraph(scoped).nodes.get(ID_ALPHA);
    expect(box).toBeDefined();
    const c = centeredWorldPoint();
    expect(c.x).toBeCloseTo(box!.cx, 4);
    expect(c.y).toBeCloseTo(box!.cy, 4);
    // 节点仍在图里（没有被裁剪掉）
    expect(screen.queryByTestId('graph-node-' + ID_ALPHA)).not.toBeNull();
  });

  it('点击调用点：选中的是被调方（callee），不是所在函数', () => {
    preset(sampleProject());
    render(<AppRoot />);

    // a.py 第 4 行 "    return beta()" 里的 beta
    clickTestId('code-token-call-4');

    const sel = useAppStore.getState().selection;
    expect(sel.funcId).toBe(ID_BETA);
    expect(sel.source).toBe('code');
  });

  it('选中当前范围外的函数时自动切到它的邻域，保证右侧能居中', () => {
    preset(sampleProject());
    // depth=0 的邻域里只有 beta 自己，alpha 一定在范围外
    const narrow = neighborhoodScope(ID_BETA, 0);
    useAppStore.setState({ scope: narrow });
    const before = applyScope(useAppStore.getState().graph!, narrow);
    expect(scopeContains(before, ID_ALPHA)).toBe(false);

    useAppStore.getState().selectFromCode(ID_ALPHA);

    const st = useAppStore.getState();
    expect(st.scope).toMatchObject({ kind: 'neighborhood', funcId: ID_ALPHA });
    const scoped = applyScope(st.graph!, st.scope);
    expect(scopeContains(scoped, ID_ALPHA)).toBe(true);
  });

  it('选中当前范围内的函数时保持原范围不变，避免无谓重排布局', () => {
    preset(sampleProject());
    // file 范围会带上 1 跳邻居（否则跨文件边画不出来），所以 a.py 的 alpha 也在里面
    useAppStore.setState({ scope: fileScope(B_PATH) });

    useAppStore.getState().selectFromCode(ID_ALPHA);

    expect(useAppStore.getState().scope).toEqual(fileScope(B_PATH));
    expect(useAppStore.getState().selection.funcId).toBe(ID_ALPHA);
  });
});

describe('代码区窗口化渲染', () => {
  it('4200 行只渲染可视区间 +/- buffer', () => {
    preset(bigProject(1400));
    render(<AppRoot />);

    // 默认视口 600px / ROW_H 20 -> 30 行，加 24 行 buffer = 54
    expect(screen.queryByTestId('code-line-1')).not.toBeNull();
    expect(screen.queryByTestId('code-line-54')).not.toBeNull();
    expect(screen.queryByTestId('code-line-55')).toBeNull();
    expect(screen.queryByTestId('code-line-1000')).toBeNull();
    expect(screen.queryByTestId('code-line-4200')).toBeNull();
  });
});

describe('CodeRow：序号角标占掉 ƒ 的标记槽', () => {
  const callee = func(M_PATH, 'callee', { defLine: 5, startLine: 5, endLine: 6 });

  const renderRow = (chipIndex: number | null, defFunc: typeof callee | null) =>
    render(
      <CodeRow
        line={5}
        text="    callee()"
        spans={undefined}
        ranges={undefined}
        defFunc={defFunc}
        chipIndex={chipIndex}
        inSelection={false}
        onBodyPress={() => {}}
        onTokenPress={() => {}}
      />
    );

  it('角标在前、行号在后，同槽的 ƒ 让位', () => {
    renderRow(2, callee);
    const chip = screen.getByTestId('callsite-mark-active');
    expect(chip.textContent).toBe('2');
    expect(screen.queryByTestId('code-def-mark-5')).toBeNull();
    const gutter = chip.parentElement?.parentElement;
    expect(gutter?.firstElementChild?.contains(chip)).toBe(true);
    expect(gutter?.lastElementChild?.textContent).toBe('5');
  });

  it('没有角标时 ƒ 回到原位', () => {
    renderRow(null, callee);
    expect(screen.queryByTestId('callsite-mark-active')).toBeNull();
    expect(screen.queryByTestId('code-def-mark-5')).not.toBeNull();
  });
});

describe('验收 3：点调用关系图的线 -> 定位到 A 调用 B 的那一行', () => {
  const countText = (): string => screen.getByTestId('callsite-count').textContent ?? '';

  it('点线：代码区切到调用点所在文件，落在第 1 处，底栏写明定位到的 file:line', () => {
    preset(multiCallProject(), N_PATH);
    render(<AppRoot />);
    // 首帧之后 GraphPane 会自己 fit 一次，之后就不该再动视图
    const viewBefore = useAppStore.getState().view;

    tapGraphEdge(ID_CALLER, ID_CALLEE);

    const st = useAppStore.getState();
    expect(st.activeFile).toBe(M_PATH);
    expect(st.edgeSelection).toMatchObject({
      source: ID_CALLER,
      target: ID_CALLEE,
      index: 0,
      count: 3,
      origin: 'graph',
    });
    // 只高亮这条线：不动节点选中 / 范围 / 视图（连平移都不该发生）
    expect(st.selection).toEqual(NO_SELECTION);
    expect(st.scope).toEqual(ALL_SCOPE);
    expect(st.view).toBe(viewBefore);

    expect(countText()).toBe('1/3');
    expect(screen.getByTestId('graph-edge-info').textContent ?? '').toContain('m.py:5');
    expect(screen.queryByTestId('code-flash')).not.toBeNull();
  });

  it('这条边的三处调用全部打点，只有当前那处是活动标记', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    tapGraphEdge(ID_CALLER, ID_CALLEE);

    expect(screen.getAllByTestId(/callsite-mark-\d/)).toHaveLength(3);
    // 序号角标不在内容坐标的覆盖层里，而是渲染进当前那行的 sticky gutter —— 行号左边
    const chip = screen.getByTestId('callsite-mark-active');
    const row = screen.getByTestId('code-line-5');
    expect(row.contains(chip)).toBe(true);
    expect(chip.textContent).toBe('1');
    const gutter = chip.parentElement?.parentElement; // chip -> 标记槽 -> gutter
    expect(gutter).toBe(row.firstElementChild);
    expect(gutter?.firstElementChild?.contains(chip)).toBe(true);
    expect(gutter?.lastElementChild?.textContent).toBe('5');
    expect(chip.parentElement?.nextElementSibling).toBe(gutter?.lastElementChild);
  });

  it('同一条线连着点四次：1/3 -> 2/3 -> 3/3 -> 绕回 1/3', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      tapGraphEdge(ID_CALLER, ID_CALLEE);
      seen.push(countText());
    }
    expect(seen).toEqual(['1/3', '2/3', '3/3', '1/3']);
  });

  it('Shift + 点线反向退：第一次仍是第 1 处，之后往上一处绕回', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      tapGraphEdge(ID_CALLER, ID_CALLEE, { shift: true });
      seen.push(countText());
    }
    expect(seen).toEqual(['1/3', '3/3', '2/3']);
  });

  it('代码区右下角步进器：› 往前、‹ 往后，到头绕回', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    tapGraphEdge(ID_CALLER, ID_CALLEE);
    clickTestId('callsite-next');
    expect(countText()).toBe('2/3');
    clickTestId('callsite-next');
    clickTestId('callsite-next');
    expect(countText()).toBe('1/3');
    clickTestId('callsite-prev');
    expect(countText()).toBe('3/3');
    expect(screen.getByTestId('code-flash')).not.toBeNull();
  });

  it('✕ 清掉高亮，步进器整体消失', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    tapGraphEdge(ID_CALLER, ID_CALLEE);
    clickTestId('callsite-clear');

    expect(useAppStore.getState().edgeSelection).toBeNull();
    expect(screen.queryByTestId('callsite-stepper')).toBeNull();
    expect(screen.queryByTestId('callsite-mark-active')).toBeNull();
  });

  it('只有一处调用的线：照样打点 + 角标，步进器显示 1/1 但不画两枚箭头', () => {
    preset(multiCallProject(), N_PATH);
    render(<AppRoot />);

    tapGraphEdge(ID_INDIRECT, ID_CALLEE);

    // 语义从没变过：N=1 的线也是 {index:0,count:1}，代码区也照常铺痕迹（读法 B：不藏控件）
    expect(useAppStore.getState().edgeSelection).toMatchObject({ index: 0, count: 1 });
    expect(screen.getByTestId('callsite-count').textContent).toBe('1/1');
    // 没有可走的路，所以两枚箭头不渲染；✕ 仍然在，清除这条动作对 N=1 同样有意义
    expect(screen.queryByTestId('callsite-prev')).toBeNull();
    expect(screen.queryByTestId('callsite-next')).toBeNull();
    expect(screen.queryByTestId('callsite-clear')).not.toBeNull();
    // 那一处调用仍然打点，并且是当前处 -> 行号左边挂角标 '1'
    expect(screen.getAllByTestId(/callsite-mark-\d/)).toHaveLength(1);
    const chip = screen.getByTestId('callsite-mark-active');
    expect(chip.textContent).toBe('1');
    expect(screen.getByTestId('code-line-4').contains(chip)).toBe(true);
    // 底栏仍然只写 file:line，不拼 k/N（1/1 只在步进器里读）
    const info = screen.getByTestId('graph-edge-info').textContent ?? '';
    expect(info).toContain('n.py:4');
    expect(info).not.toContain('/');
    expect(screen.queryByTestId('code-flash')).not.toBeNull();
  });

  it('点节点 / 点空白都会取消线的高亮：一次只有一个焦点', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    tapGraphEdge(ID_CALLER, ID_CALLEE);
    tapGraphNode(ID_CALLEE);
    expect(useAppStore.getState().edgeSelection).toBeNull();

    tapGraphEdge(ID_CALLER, ID_CALLEE);
    expect(useAppStore.getState().edgeSelection).not.toBeNull();
    tapPoint(770, 570);
    expect(useAppStore.getState().edgeSelection).toBeNull();
    expect(screen.queryByTestId('callsite-stepper')).toBeNull();
  });

  it('在线上起手拖动：只平移视图，不能误选中这条边', () => {
    preset(multiCallProject());
    render(<AppRoot />);

    const p = edgeClientPoint(ID_CALLER, ID_CALLEE);
    const tx0 = useAppStore.getState().view.tx;
    dragGraph(p, DRAG_SLOP + 20, 0);

    expect(useAppStore.getState().edgeSelection).toBeNull();
    expect(useAppStore.getState().view.tx).toBeCloseTo(tx0 + DRAG_SLOP + 20, 6);
  });

  it('反向：点代码里的第 3 处调用，点亮线上对应的那一处且不再滚动', () => {
    preset(multiCallProject(), M_PATH);
    render(<AppRoot />);

    // m.py 第 7 行 "    return callee()" 里的 callee
    clickTestId('code-token-call-7');

    const st = useAppStore.getState();
    expect(st.selection).toMatchObject({ funcId: ID_CALLEE, source: 'code' });
    expect(st.edgeSelection).toMatchObject({
      source: ID_CALLER,
      target: ID_CALLEE,
      index: 2,
      count: 3,
      origin: 'code',
    });
    expect(countText()).toBe('3/3');
    expect(screen.getByTestId('graph-edge-info').textContent ?? '').toContain('m.py:7');
    // origin=code：代码本来就在眼前，不重放定位闪烁
    expect(screen.queryByTestId('code-flash')).toBeNull();
  });
});

