/**
 * store 的 reducer 行为。
 *
 * 重点是双向定位的两条 action：selectFromGraph（图 -> 代码）与
 * selectFromCode（代码 -> 图），以及 nonce 让"重复点击同一个目标"仍能重新触发定位。
 * 解析走注入的假 parser，整个文件不依赖 wasm。
 */
import {
  ALL_SCOPE,
  DEFAULT_DEPTH,
  fileScope,
  neighborhoodScope,
} from '../src/graph/scope';
import type { PythonParser } from '../src/parser/treeSitter';
import type { PickedFile } from '../src/parser/types';
import {
  DEFAULT_SPLIT,
  IDENTITY_VIEW,
  MAX_SPLIT,
  MIN_SPLIT,
  NO_SELECTION,
  clampSplit,
  funcFile,
  useAppStore,
} from '../src/state/store';
import type { AppStore } from '../src/state/store';
import {
  A_PATH,
  B_PATH,
  ID_ALPHA,
  ID_BETA,
  ID_CALLEE,
  ID_CALLER,
  ID_GAMMA,
  ID_INDIRECT,
  ID_USE_GAMMA,
  M_PATH,
  N_PATH,
  multiCallProject,
  sampleProject,
} from './helpers/sampleProject';
import type { SampleProject } from './helpers/sampleProject';

/** 永远返回空树的假 parser：走"解析失败"分支，用来测 store 的异步流程。 */
const NULL_PARSER: PythonParser = {
  parse: () => null,
  dispose: () => {},
};

const INITIAL = useAppStore.getState();

function reset(): void {
  useAppStore.setState({ ...INITIAL }, true);
}

/** 用合成工程预置 store，模拟"已经上传并解析完成"的状态。 */
function preset(p: SampleProject = sampleProject(), extra: Partial<AppStore> = {}): void {
  reset();
  useAppStore.setState({
    files: p.files,
    analyses: p.analyses,
    highlights: p.highlights,
    graph: p.graph,
    status: 'ready',
    error: null,
    warnings: [],
    progress: { done: p.files.length, total: p.files.length },
    activeFile: p.files[0]?.path ?? null,
    selection: NO_SELECTION,
    scope: ALL_SCOPE,
    splitRatio: DEFAULT_SPLIT,
    view: IDENTITY_VIEW,
    fitNonce: 0,
    parser: NULL_PARSER,
    ...extra,
  });
}

const s = (): AppStore => useAppStore.getState();

beforeEach(reset);

describe('纯函数辅助', () => {
  it('funcFile 从 FuncId 里取出文件路径', () => {
    expect(funcFile(ID_ALPHA)).toBe(A_PATH);
    expect(funcFile(ID_GAMMA)).toBe(B_PATH);
    expect(funcFile('pkg/x.py::C.m')).toBe('pkg/x.py');
  });

  it('funcFile 对没有分隔符的字符串返回空串', () => {
    expect(funcFile('nope')).toBe('');
  });

  it('clampSplit 夹到 [MIN_SPLIT, MAX_SPLIT]', () => {
    expect(clampSplit(0)).toBe(MIN_SPLIT);
    expect(clampSplit(1)).toBe(MAX_SPLIT);
    expect(clampSplit(0.5)).toBe(0.5);
    expect(MIN_SPLIT).toBeLessThan(DEFAULT_SPLIT);
    expect(DEFAULT_SPLIT).toBeLessThan(MAX_SPLIT);
  });
});

describe('selectFromGraph（图 -> 代码）', () => {
  it('写入 selection 并把 source 标成 graph', () => {
    preset();
    s().selectFromGraph(ID_BETA);
    expect(s().selection).toEqual({ funcId: ID_BETA, source: 'graph', nonce: 1 });
  });

  it('重复点击同一个节点时 nonce 继续自增（否则代码区不会重新滚动/闪烁）', () => {
    preset();
    s().selectFromGraph(ID_BETA);
    s().selectFromGraph(ID_BETA);
    s().selectFromGraph(ID_BETA);
    expect(s().selection.funcId).toBe(ID_BETA);
    expect(s().selection.nonce).toBe(3);
  });

  it('目标函数在别的文件里时自动切 activeFile', () => {
    preset(sampleProject(), { activeFile: A_PATH });
    s().selectFromGraph(ID_GAMMA);
    expect(s().activeFile).toBe(B_PATH);
  });

  it('目标函数的文件不在已上传列表里时保留当前 activeFile', () => {
    preset(sampleProject(), { activeFile: A_PATH });
    s().selectFromGraph('__external__::builtins');
    expect(s().activeFile).toBe(A_PATH);
  });

  it('当前是邻域范围时，跟随选中项重新邻域，并保留原有 depth', () => {
    preset(sampleProject(), { scope: neighborhoodScope(ID_ALPHA, 2) });
    s().selectFromGraph(ID_GAMMA);
    expect(s().scope).toEqual({ kind: 'neighborhood', funcId: ID_GAMMA, depth: 2 });
  });

  it('当前不是邻域范围时不动 scope（全部 / 本文件下点节点不该缩小视野）', () => {
    preset(sampleProject(), { scope: ALL_SCOPE });
    const before = s().scope;
    s().selectFromGraph(ID_GAMMA);
    expect(s().scope).toBe(before);

    preset(sampleProject(), { scope: fileScope(A_PATH) });
    const beforeFile = s().scope;
    s().selectFromGraph(ID_GAMMA);
    expect(s().scope).toBe(beforeFile);
  });
});

describe('selectFromCode（代码 -> 图）', () => {
  it('写入 selection 并把 source 标成 code', () => {
    preset();
    s().selectFromCode(ID_ALPHA);
    expect(s().selection).toEqual({ funcId: ID_ALPHA, source: 'code', nonce: 1 });
  });

  it('目标已在当前范围内时保持 scope 不变', () => {
    preset(sampleProject(), { scope: ALL_SCOPE });
    const before = s().scope;
    s().selectFromCode(ID_USE_GAMMA);
    expect(s().scope).toBe(before);
  });

  it('目标不在当前范围内时自动切到它的邻域，否则右侧没法居中', () => {
    // depth=0 -> 范围里只有 alpha 自己
    preset(sampleProject(), { scope: neighborhoodScope(ID_ALPHA, 0) });
    s().selectFromCode(ID_GAMMA);
    expect(s().scope).toEqual({
      kind: 'neighborhood',
      funcId: ID_GAMMA,
      depth: DEFAULT_DEPTH,
    });
  });

  it('本文件范围已经把直接跨文件邻居算进来了，因此点 b.py 的函数不必切换范围', () => {
    // fileScope 的语义是"本文件全部函数 + 直接触达它们的跨文件邻居"，
    // gamma 既是 use_gamma 的被调方又是 alpha 的调用方，本来就在视野里。
    preset(sampleProject(), { scope: fileScope(A_PATH) });
    const before = s().scope;
    s().selectFromCode(ID_GAMMA);
    expect(s().scope).toBe(before);
    expect(s().selection.funcId).toBe(ID_GAMMA);
  });

  it('点击空白处（funcId=null）清空选中但保留 nonce 递增', () => {
    preset(sampleProject(), { selection: { funcId: ID_ALPHA, source: 'graph', nonce: 7 } });
    s().selectFromCode(null);
    expect(s().selection).toEqual({ funcId: null, source: 'code', nonce: 8 });
  });

  it('重复点击同一行同样靠 nonce 重新居中', () => {
    preset();
    s().selectFromCode(ID_BETA);
    s().selectFromCode(ID_BETA);
    expect(s().selection.nonce).toBe(2);
  });

  it('没有图（尚未上传）时不炸：无法判断可见性，直接按目标函数准备邻域', () => {
    reset();
    expect(s().graph).toBeNull();
    expect(() => s().selectFromCode(ID_ALPHA)).not.toThrow();
    expect(s().selection).toEqual({ funcId: ID_ALPHA, source: 'code', nonce: 1 });
    expect(s().scope).toEqual({ kind: 'neighborhood', funcId: ID_ALPHA, depth: DEFAULT_DEPTH });
  });
});

describe('两侧交替点击共享同一个 nonce 计数器', () => {
  it('code -> graph -> code 连续递增', () => {
    preset();
    s().selectFromCode(ID_ALPHA);
    s().selectFromGraph(ID_BETA);
    s().selectFromCode(ID_BETA);
    expect(s().selection).toEqual({ funcId: ID_BETA, source: 'code', nonce: 3 });
  });
});

describe('setScope', () => {
  it('切换范围时请求重新适应窗口', () => {
    preset(sampleProject(), { fitNonce: 3 });
    s().setScope(fileScope(A_PATH));
    expect(s().scope).toEqual({ kind: 'file', file: A_PATH });
    expect(s().fitNonce).toBe(4);
  });

  it('选中项仍在新范围内时保留选中（含 source 与 nonce）', () => {
    const sel = { funcId: ID_ALPHA, source: 'graph' as const, nonce: 9 };
    // alpha 是 beta 的直接 caller，depth=1 的邻域里有它
    preset(sampleProject(), { selection: sel, scope: ALL_SCOPE });
    s().setScope(neighborhoodScope(ID_BETA, 1));
    expect(s().selection).toBe(sel);
  });

  it('选中项掉出范围时清空选中，但 source 记为 scope 且 nonce 不跳', () => {
    preset(sampleProject(), {
      selection: { funcId: ID_ALPHA, source: 'graph', nonce: 9 },
      scope: ALL_SCOPE,
    });
    s().setScope(neighborhoodScope(ID_GAMMA, 0));
    expect(s().selection).toEqual({ funcId: null, source: 'scope', nonce: 9 });
  });

  it('没有选中项时清空后仍是空', () => {
    preset();
    s().setScope(ALL_SCOPE);
    expect(s().selection.funcId).toBeNull();
    expect(s().selection.nonce).toBe(0);
  });
});

describe('视图与开关', () => {
  it('setView 做浅合并，未给的字段保持原值', () => {
    preset(sampleProject(), { view: { tx: 10, ty: 20, scale: 1.5 } });
    s().setView({ tx: 99 });
    expect(s().view).toEqual({ tx: 99, ty: 20, scale: 1.5 });
  });

  it('fitView 只 bump fitNonce，不动 view', () => {
    preset(sampleProject(), { fitNonce: 1, view: { tx: 5, ty: 5, scale: 1 } });
    const before = s().view;
    s().fitView();
    expect(s().fitNonce).toBe(2);
    expect(s().view).toBe(before);
  });


  it('setSplitRatio 夹到合法区间', () => {
    preset();
    s().setSplitRatio(5);
    expect(s().splitRatio).toBe(MAX_SPLIT);
    s().setSplitRatio(-5);
    expect(s().splitRatio).toBe(MIN_SPLIT);
  });

  it('setActiveFile 切文件；重复设成同一个不产生新状态', () => {
    preset();
    const before = s();
    s().setActiveFile(A_PATH);
    expect(useAppStore.getState()).toBe(before);
    s().setActiveFile(B_PATH);
    expect(s().activeFile).toBe(B_PATH);
  });
});

describe('loadFiles / addFiles / removeFile', () => {
  const py = (path: string, content: string): PickedFile => ({
    path,
    name: path.split('/').pop() ?? path,
    content,
  });

  it('空列表 -> 回到 idle 并清空所有派生状态', async () => {
    preset();
    await s().loadFiles([]);
    expect(s().status).toBe('idle');
    expect(s().files).toEqual([]);
    expect(s().graph).toBeNull();
    expect(s().activeFile).toBeNull();
    expect(s().selection).toEqual(NO_SELECTION);
    expect(s().scope).toEqual(ALL_SCOPE);
  });

  it('解析失败时 status 仍是 ready，但给出致命错误与逐文件告警', async () => {
    reset();
    await s().loadFiles([py('a.py', 'def f():\n    pass\n')], NULL_PARSER);
    expect(s().status).toBe('ready');
    expect(s().error).toContain('All files failed to parse');
    expect(s().warnings).toHaveLength(1);
    expect(s().warnings[0]).toContain('a.py');
    expect(s().graph?.nodes).toEqual([]);
  });

  it('progress 在结束时对齐文件数', async () => {
    reset();
    await s().loadFiles([py('a.py', 'x = 1\n'), py('b.py', 'y = 2\n')], NULL_PARSER);
    expect(s().progress).toEqual({ done: 2, total: 2 });
  });

  it('addFiles 按路径合并，同路径后者覆盖前者', async () => {
    reset();
    await s().loadFiles([py('a.py', 'v = 1\n'), py('b.py', 'v = 2\n')], NULL_PARSER);
    await s().addFiles([py('a.py', 'v = 999\n')], NULL_PARSER);
    expect(s().files.map((f) => f.path)).toEqual(['a.py', 'b.py']);
    expect(s().files[0]?.content).toBe('v = 999\n');
  });

  it('addFiles 新增文件时保留原有 activeFile', async () => {
    reset();
    await s().loadFiles([py('a.py', 'v = 1\n')], NULL_PARSER);
    expect(s().activeFile).toBe('a.py');
    await s().addFiles([py('b.py', 'v = 2\n')], NULL_PARSER);
    expect(s().activeFile).toBe('a.py');
    expect(s().files.map((f) => f.path)).toEqual(['a.py', 'b.py']);
  });

  it('removeFile 移除单个文件后其余文件重新解析', async () => {
    reset();
    await s().loadFiles([py('a.py', 'v = 1\n'), py('b.py', 'v = 2\n')], NULL_PARSER);
    await s().removeFile('a.py');
    expect(s().files.map((f) => f.path)).toEqual(['b.py']);
    expect(s().activeFile).toBe('b.py');
  });

  it('移除最后一个文件后回到 idle', async () => {
    reset();
    await s().loadFiles([py('a.py', 'v = 1\n')], NULL_PARSER);
    await s().removeFile('a.py');
    expect(s().status).toBe('idle');
    expect(s().files).toEqual([]);
    expect(s().activeFile).toBeNull();
  });

  it('移除当前激活文件后 activeFile 落到剩余的第一个', async () => {
    reset();
    await s().loadFiles([py('a.py', 'v = 1\n'), py('b.py', 'v = 2\n')], NULL_PARSER);
    s().setActiveFile('a.py');
    await s().removeFile('a.py');
    expect(s().activeFile).toBe('b.py');
  });

  it('解析器抛异常时进入 error 状态并带上原始信息', async () => {
    reset();
    const boom: PythonParser = {
      parse: () => {
        throw new Error('ABI incompatible');
      },
      dispose: () => {},
    };
    await s().loadFiles([py('a.py', 'def f():\n    pass\n')], boom);
    // 单文件异常被 analyzeFiles 兜住并记在 file.error 上，因此走的是"全部失败"分支
    expect(s().status).toBe('ready');
    expect(s().warnings[0]).toContain('ABI incompatible');
  });

  it('loadFiles 成功后重置 selection / scope / view', async () => {
    preset(sampleProject(), {
      selection: { funcId: ID_ALPHA, source: 'graph', nonce: 5 },
      scope: neighborhoodScope(ID_ALPHA),
      view: { tx: 100, ty: 100, scale: 2 },
      fitNonce: 2,
    });
    await s().loadFiles([py('a.py', 'v = 1\n')], NULL_PARSER);
    expect(s().selection).toEqual(NO_SELECTION);
    expect(s().scope).toEqual(ALL_SCOPE);
    expect(s().view).toEqual(IDENTITY_VIEW);
    expect(s().fitNonce).toBe(3);
  });
});

describe('reset', () => {
  it('清空一切但保留 splitRatio 这类用户偏好', async () => {
    preset(sampleProject(), {
      selection: { funcId: ID_ALPHA, source: 'graph', nonce: 4 },
      scope: fileScope(B_PATH),
      view: { tx: 3, ty: 4, scale: 2 },
      splitRatio: 0.6,
      fitNonce: 8,
    });
    await s().reset();
    const after = s();
    expect(after.files).toEqual([]);
    expect(after.analyses).toEqual([]);
    expect(after.highlights.size).toBe(0);
    expect(after.graph).toBeNull();
    expect(after.status).toBe('idle');
    expect(after.error).toBeNull();
    expect(after.warnings).toEqual([]);
    expect(after.activeFile).toBeNull();
    expect(after.selection).toEqual(NO_SELECTION);
    expect(after.scope).toEqual(ALL_SCOPE);
    expect(after.view).toEqual(IDENTITY_VIEW);
    expect(after.fitNonce).toBe(9);
    // 偏好不属于"数据"，reset 不动它们
    expect(after.splitRatio).toBe(0.6);
  });
});


describe('边选中：点一条线 -> 定位调用点', () => {
  const cur = (): AppStore => useAppStore.getState();
  const edgeOf = (): AppStore['edgeSelection'] => cur().edgeSelection;

  it('首次点边落在第 1 处调用，并把 activeFile 切到调用点所在文件', () => {
    preset(multiCallProject(), { activeFile: N_PATH });
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    expect(edgeOf()).toMatchObject({
      source: ID_CALLER,
      target: ID_CALLEE,
      index: 0,
      count: 3,
      origin: 'graph',
    });
    expect(cur().activeFile).toBe(M_PATH);
  });

  it('同一条边再点一次依次往后，第四次绕回第 1 处', () => {
    preset(multiCallProject());
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
      seen.push(edgeOf()?.index ?? -1);
    }
    expect(seen).toEqual([0, 1, 2, 0]);
  });

  it('Shift 反向：第一次仍从第 1 处开始，之后每次往后退一处并绕回', () => {
    preset(multiCallProject());
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE, true);
      seen.push(edgeOf()?.index ?? -1);
    }
    expect(seen).toEqual([0, 2, 1, 0, 2]);
  });

  it('换一条边从第一处开始：序号只在同一条边内累加', () => {
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    expect(edgeOf()?.index).toBe(1);
    cur().selectEdgeFromGraph(ID_INDIRECT, ID_CALLEE);
    expect(edgeOf()).toMatchObject({ source: ID_INDIRECT, target: ID_CALLEE, index: 0, count: 1 });
  });

  it('步进器：+1 到头绕回，-1 到底绕到末尾，来源标成 graph（代码区要跟着滚）', () => {
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().stepEdge(1);
    expect(edgeOf()?.index).toBe(1);
    cur().stepEdge(1);
    expect(edgeOf()?.index).toBe(2);
    cur().stepEdge(1);
    expect(edgeOf()?.index).toBe(0);
    cur().stepEdge(-1);
    expect(edgeOf()?.index).toBe(2);
    expect(edgeOf()?.origin).toBe('graph');
  });

  it('没有选中边时 stepEdge 原样返回（不产生新 state、不报空）', () => {
    preset(multiCallProject());
    const before = cur();
    before.stepEdge(1);
    expect(cur()).toBe(before);
    expect(cur().edgeSelection).toBeNull();
  });

  it('点边不动 selection / scope / navHistory / view：只高亮这条线并换文件', () => {
    preset(multiCallProject());
    cur().selectFromGraph(ID_CALLEE);
    cur().selectFromGraph(ID_CALLER);
    const before = cur();
    const snap = {
      selection: before.selection,
      scope: before.scope,
      navHistory: before.navHistory,
      navIndex: before.navIndex,
      view: before.view,
    };
    before.selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    const after = cur();
    expect(after.selection).toEqual(snap.selection);
    expect(after.scope).toEqual(snap.scope);
    expect(after.navHistory).toEqual(snap.navHistory);
    expect(after.navIndex).toBe(snap.navIndex);
    expect(after.view).toEqual(snap.view);
    expect(after.edgeSelection).not.toBeNull();
  });

  it('代码区点调用点：origin=code 且保留点中的那一处序号', () => {
    preset(multiCallProject());
    cur().selectEdgeFromCode(ID_CALLER, ID_CALLEE, 2);
    expect(edgeOf()).toMatchObject({ index: 2, count: 3, origin: 'code' });
  });

  it('序号越界（图刚变过、调用点少了一个）归到第一处，而不是崩掉', () => {
    preset(multiCallProject());
    cur().selectEdgeFromCode(ID_CALLER, ID_CALLEE, 99);
    expect(edgeOf()?.index).toBe(0);
  });

  it('边不存在时整块状态原样返回（点到了空气）', () => {
    preset(multiCallProject());
    const before = cur();
    before.selectEdgeFromGraph(ID_CALLEE, ID_CALLER);
    expect(cur()).toBe(before);
    expect(cur().edgeSelection).toBeNull();
  });

  it('清空后重新点同一处也换新 nonce：否则代码区不会重放滚动与闪烁', () => {
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    const first = edgeOf()?.nonce ?? -1;
    cur().clearEdgeSelection();
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    expect(edgeOf()?.index).toBe(0);
    expect((edgeOf()?.nonce ?? -1) as number).toBeGreaterThan(first);
  });

  it('点节点 / 点代码 / 切范围 / 前进后退都清掉边选中（一次只有一个焦点）', () => {
    preset(multiCallProject());
    cur().selectFromGraph(ID_CALLEE);
    cur().selectFromGraph(ID_CALLER);
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().selectFromGraph(ID_CALLEE);
    expect(cur().edgeSelection).toBeNull();

    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().selectFromCode(ID_CALLEE);
    expect(cur().edgeSelection).toBeNull();

    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().setScope(fileScope(M_PATH));
    expect(cur().edgeSelection).toBeNull();
    expect(cur().scope).toEqual(fileScope(M_PATH));

    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    cur().navBack();
    expect(cur().edgeSelection).toBeNull();
  });

  it('clearEdgeSelection 在本来就没有选中时返回同一个 state 引用', () => {
    preset(multiCallProject());
    const before = cur();
    before.clearEdgeSelection();
    expect(cur()).toBe(before);
  });

  it('边序号不随 reset 回卷：重开一次分析后再次点边，nonce 仍比上次大', () => {
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    const before = edgeOf()?.nonce ?? -1;
    useAppStore.getState().reset();
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    expect((edgeOf()?.nonce ?? -1) as number).toBeGreaterThan(before);
  });

  it('reset 清空边选中', async () => {
    preset(multiCallProject());
    cur().selectEdgeFromGraph(ID_CALLER, ID_CALLEE);
    await cur().reset();
    expect(cur().edgeSelection).toBeNull();
  });
});
