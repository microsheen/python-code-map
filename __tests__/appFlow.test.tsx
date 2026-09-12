/**
 * 端到端组件测试：验证用户提出的两条核心验收。
 *
 *   1. 点击图中的函数 -> 左侧自动切到该文件、定位到 def 行、高亮函数体
 *   2. 点击代码中的函数 -> 右侧自动把该节点居中并高亮
 *
 * 环境说明：jest.config.js 用的是 jest-expo/web 预设，即 jsdom + `react-native` 别名到
 * `react-native-web`，所以这里用 @testing-library/react 与 fireEvent.click（真实 DOM 事件），
 * 而不是 @testing-library/react-native 的 fireEvent.press —— 后者在 RNW 下会因为
 * "Text strings must be rendered within a <Text>" 不变量直接炸掉。
 *
 * react-native-svg 被打桩成 RN 基础组件：只保留 testID / onPress / children，
 * 丢掉全部 SVG 几何属性（既避免 DOM 未知属性告警，也让节点在 jsdom 里真的可点）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppRoot } from '../src/components/AppRoot';
import { DEFAULT_VIEWPORT } from '../src/components/GraphPane';
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
  A_PATH,
  B_PATH,
  ID_ALPHA,
  ID_BETA,
  ID_GAMMA,
  bigProject,
  sampleProject,
  type SampleProject,
} from './helpers/sampleProject';

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
          props.children,
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
      showExternal: false,
      splitRatio: DEFAULT_SPLIT,
      view: IDENTITY_VIEW,
      fitNonce: 0,
      parser: NULL_PARSER,
    },
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

afterEach(() => {
  cleanup();
  useAppStore.getState().reset();
});

describe('验收 1：图 -> 代码', () => {
  it('点击图中节点：selection 变成 graph 来源，nonce 自增', () => {
    preset(sampleProject());
    render(<AppRoot />);

    clickTestId('graph-node-' + ID_ALPHA);

    const sel = useAppStore.getState().selection;
    expect(sel.funcId).toBe(ID_ALPHA);
    expect(sel.source).toBe('graph');
    expect(sel.nonce).toBe(1);
  });

  it('点击另一个文件里的节点：左侧自动切换文件并画出函数体高亮带', () => {
    preset(sampleProject(), A_PATH);
    render(<AppRoot />);

    // 前置：当前显示的是 a.py（第 1 行是 "import b"，没有 from）
    expect(screen.getByTestId('code-line-1').textContent ?? '').not.toContain('from');

    clickTestId('graph-node-' + ID_GAMMA);

    const st = useAppStore.getState();
    expect(st.activeFile).toBe(B_PATH);
    expect(st.selection).toMatchObject({ funcId: ID_GAMMA, source: 'graph', nonce: 1 });

    // 左侧内容确实换成了 b.py（第 1 行是 "from a import alpha"）
    expect(screen.getByTestId('code-line-1').textContent ?? '').toContain('from');
    // 函数体高亮带存在（startLine..endLine）
    expect(screen.queryByTestId('code-selection-band')).not.toBeNull();
  });

  it('重复点击同一个节点：funcId 不变但 nonce 继续自增，定位可重复触发', () => {
    preset(sampleProject());
    render(<AppRoot />);

    clickTestId('graph-node-' + ID_BETA);
    clickTestId('graph-node-' + ID_BETA);
    clickTestId('graph-node-' + ID_BETA);

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
    const scoped = applyScope(st.graph!, st.scope, { showExternal: st.showExternal });
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
    const before = applyScope(useAppStore.getState().graph!, narrow, { showExternal: false });
    expect(scopeContains(before, ID_ALPHA)).toBe(false);

    useAppStore.getState().selectFromCode(ID_ALPHA);

    const st = useAppStore.getState();
    expect(st.scope).toMatchObject({ kind: 'neighborhood', funcId: ID_ALPHA });
    const scoped = applyScope(st.graph!, st.scope, { showExternal: st.showExternal });
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
