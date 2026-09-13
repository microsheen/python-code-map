/**
 * 真实 wasm 全链路端到端测试。
 *
 * 三个测试文件的分工：
 * - parser.wasm.test.ts：真语法树校验解析规则（符号 / import / 连边 / reason / 统计基线）
 * - appFlow.test.tsx   ：预置 store 校验两条核心验收的交互逻辑（不依赖 wasm）
 * - 本文件             ：把两者接起来 —— 真 wasm 解析 fixtures -> store.loadFiles ->
 *                        渲染 AppRoot -> 真点击，确认"解析产物 + 组件树"配合无误。
 *
 * 因此这里刻意不重复断言连边矩阵（那是 parser.wasm.test.ts 的职责），
 * 只断言"数据流过 UI 之后仍然正确"的部分。
 *
 * react-native-svg 的打桩与 appFlow.test.tsx 完全一致（原因见那里的文件头注释）。
 * public/wasm 缺失时整个文件跳过（见 helpers/wasm.ts）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppRoot } from '../src/components/AppRoot';
import { DEFAULT_VIEWPORT } from '../src/components/GraphPane';
import { layoutGraph } from '../src/graph/layout';
import { applyScope } from '../src/graph/scope';
import type { CallGraph, PickedFile } from '../src/parser/types';
import { useAppStore } from '../src/state/store';
import { describeWasm, fixtureFile, getTestParser } from './helpers/wasm';

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

const THREE = ['main.py', 'shapes.py', 'utils.py'];

/** fixture 的 PyFile 结构上就是 PickedFile（多出的 lines 字段无害）。 */
function picked(names: string[]): PickedFile[] {
  return names.map((n) => {
    const f = fixtureFile(n);
    return { path: f.path, name: f.name, content: f.content };
  });
}

/** 走真实管线：真 wasm parser + analyzeFiles + 建图，全部包在 act 里。 */
async function load(names: string[]): Promise<void> {
  const parser = await getTestParser();
  await act(async () => {
    await useAppStore.getState().loadFiles(picked(names), parser);
  });
}

function hasEdge(g: CallGraph, source: string, target: string): boolean {
  return g.edges.some((e) => e.source === source && e.target === target);
}

/** 同一行可能被切成多个可点击片段（高亮 span 的边界会切开调用表达式），取第一个即可。 */
function clickFirst(id: string): void {
  const els = screen.getAllByTestId(id);
  const el = els[0];
  if (!el) throw new Error('找不到 testID: ' + id);
  fireEvent.click(el);
}

/** 当前 view 把哪个世界坐标点放到了视口中心（与 GraphPane 的换算保持一致）。 */
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

describeWasm('全链路：上传 -> 解析 -> 出图', () => {
  it('loadFiles 后 store 进入 ready，图里能看到跨文件边与递归自环', async () => {
    await load(THREE);
    render(<AppRoot />);

    const st = useAppStore.getState();
    expect(st.status).toBe('ready');
    expect(st.error).toBeNull();
    expect(st.warnings).toEqual([]);
    expect(st.activeFile).toBe('main.py');
    expect(st.progress).toEqual({ done: 3, total: 3 });

    const g = st.graph!;
    expect(g.files).toHaveLength(3);
    expect(g.files).toEqual(expect.arrayContaining(THREE));
    expect(hasEdge(g, 'main.py::boot', 'utils.py::load_config')).toBe(true);
    expect(hasEdge(g, 'shapes.py::Circle.__init__', 'utils.py::clamp')).toBe(true);
    expect(g.edges.some((e) => e.selfLoop && e.source === 'main.py::factorial')).toBe(true);

    // 图已经真的渲染出来了（不是只有 store 里有数据）
    expect(screen.queryByTestId('graph-node-main.py::boot')).not.toBeNull();
    expect(screen.queryByTestId('code-line-22')).not.toBeNull();
  });

  it('混入语法错误的文件：降级为顶部告警，其余文件照常出图', async () => {
    await load([...THREE, 'broken.py']);
    render(<AppRoot />);

    const st = useAppStore.getState();
    expect(st.status).toBe('ready');
    expect(st.error).toBeNull();
    expect(st.warnings).toHaveLength(1);
    expect(st.warnings[0]).toContain('broken.py');
    expect(hasEdge(st.graph!, 'main.py::boot', 'utils.py::load_config')).toBe(true);

    expect(screen.queryByTestId('topbar-warnings')).not.toBeNull();
    expect(screen.getByTestId('topbar-warnings').textContent ?? '').toContain('broken.py');
  });
});

describeWasm('全链路：验收 1 图 -> 代码', () => {
  it('点击另一文件的节点：左侧切文件、定位到 def 行、画出函数体高亮带', async () => {
    await load(THREE);
    render(<AppRoot />);

    clickFirst('graph-node-utils.py::load_config');

    const st = useAppStore.getState();
    expect(st.activeFile).toBe('utils.py');
    expect(st.selection).toMatchObject({
      funcId: 'utils.py::load_config',
      source: 'graph',
      nonce: 1,
    });

    // utils.py 第 52 行就是 def load_config(path):
    const row = screen.queryByTestId('code-line-52');
    expect(row).not.toBeNull();
    expect(row!.textContent ?? '').toContain('def load_config');
    expect(screen.queryByTestId('code-selection-band')).not.toBeNull();
  });
});

describeWasm('全链路：验收 2 代码 -> 图', () => {
  it('点击代码里的函数名：右侧把该节点居中并高亮', async () => {
    await load(THREE);
    render(<AppRoot />);

    // main.py 第 22 行 def boot():
    clickFirst('code-token-def-22');

    const st = useAppStore.getState();
    expect(st.selection).toMatchObject({ funcId: 'main.py::boot', source: 'code', nonce: 1 });

    const scoped = applyScope(st.graph!, st.scope);
    const box = layoutGraph(scoped).nodes.get('main.py::boot');
    expect(box).toBeDefined();
    const c = centeredWorldPoint();
    expect(c.x).toBeCloseTo(box!.cx, 4);
    expect(c.y).toBeCloseTo(box!.cy, 4);
    expect(screen.queryByTestId('graph-node-main.py::boot')).not.toBeNull();
  });

  it('点击代码里的跨文件调用点：选中的是被调方（另一个文件的函数）', async () => {
    await load(THREE);
    render(<AppRoot />);

    // main.py 第 24 行 cfg = utils.load_config('config.txt')
    clickFirst('code-token-call-24');

    const sel = useAppStore.getState().selection;
    expect(sel.funcId).toBe('utils.py::load_config');
    expect(sel.source).toBe('code');
  });

  it('移除文件后图与代码同步更新：相关节点与跨文件边一起消失', async () => {
    await load(THREE);
    render(<AppRoot />);

    expect(screen.queryByTestId('graph-node-utils.py::load_config')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('chip-remove-utils.py'));
    });

    const st = useAppStore.getState();
    expect(st.status).toBe('ready');
    expect(st.files.map((f) => f.path)).toEqual([
      'main.py',
      'shapes.py',
    ]);
    expect(st.graph!.files).toHaveLength(2);
    expect(hasEdge(st.graph!, 'main.py::boot', 'utils.py::load_config')).toBe(false);
    expect(screen.queryByTestId('graph-node-utils.py::load_config')).toBeNull();
    expect(screen.queryByTestId('chip-utils.py')).toBeNull();
  });
});
