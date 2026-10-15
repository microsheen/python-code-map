/**
 * 全局状态（zustand）。
 *
 * 双向定位的关键是 selection.nonce：重复点击同一个节点 / 同一行时 funcId 不变，
 * 靠 nonce 自增让"滚动到行"和"居中"重新触发。
 */
import { create } from 'zustand';
import { applyScope, neighborhoodScope, scopeContains, ALL_SCOPE, type Scope } from '../graph/scope';
import { findEdge, sortedCallSites } from '../graph/edges';
import { analyzeFiles, makePyFile } from '../parser/analyze';
import { getParser, type PythonParser } from '../parser/treeSitter';
import type {
  CallGraph,
  CallSite,
  FileAnalysis,
  FuncId,
  LineTokens,
  PickedFile,
  PyFile,
} from '../parser/types';
import { saveSession, loadSession, clearSession } from '../platform/web/persist';

export type SelectionSource = 'code' | 'graph' | 'scope' | 'nav';

export interface Selection {
  funcId: FuncId | null;
  source: SelectionSource;
  /** 每次选中都 +1，用于重复点击时重新触发定位动画 */
  nonce: number;
}

export type EdgeOrigin = 'graph' | 'code';

/**
 * 图上一条「边」的选中状态。
 *
 * 一条边是同一对函数之间全部调用的聚合（ADR-0002），所以光记住 source/target 不足以定位，
 * 必须带 index —— 口径是 `sortedCallSites` 的下标（源码顺序），UI 上显示为「第 index+1/N 处」。
 * nonce 与 selection.nonce 同理：重复点同一条边的同一处时，靠它重新触发滚动与闪烁。
 */
export interface EdgeSelection {
  source: FuncId;
  target: FuncId;
  /** 0-based，指向这条边的第几个调用点 */
  index: number;
  /** 这条边的调用点总数（冗余存放，渲染 "2/3" 时不必回查图） */
  count: number;
  /** 'code' 表示这次选中由代码区点击发起：代码已经在那儿了，不要再滚动/闪烁 */
  origin: EdgeOrigin;
  nonce: number;
}

export interface ViewState {
  tx: number;
  ty: number;
  scale: number;
}

export type Status = 'idle' | 'loading-wasm' | 'parsing' | 'ready' | 'error';

export interface Progress {
  done: number;
  total: number;
}

export const IDENTITY_VIEW: ViewState = { tx: 0, ty: 0, scale: 1 };
export const DEFAULT_SPLIT = 0.35; 
export const MIN_SPLIT = 0.25;
export const MAX_SPLIT = 0.75;
export const MAX_FILES = 20;
export const NO_SELECTION: Selection = { funcId: null, source: 'scope', nonce: 0 };

export function funcFile(funcId: FuncId): string {
  const i = funcId.indexOf('::');
  return i < 0 ? '' : funcId.slice(0, i);
}

export function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
}

export interface CtxMenu { x: number; y: number; path: string; }

export interface AppStore {
  files: PyFile[];
  analyses: FileAnalysis[];
  highlights: Map<string, LineTokens[]>;
  graph: CallGraph | null;
  status: Status;
  error: string | null;
  /** 单个文件级别的告警（解析失败但其余文件正常） */
  warnings: string[];
  progress: Progress;
  activeFile: string | null;
  selection: Selection;
  /** 当前选中的边（A 调 B 的第 index 处调用）；null 表示没有选中边 */
  edgeSelection: EdgeSelection | null;
  scope: Scope;
  splitRatio: number;
  view: ViewState;
  /** +1 表示"请重新适应窗口" */
  fitNonce: number;
  parser: PythonParser | null;
  /** 导航历史：每次选中函数时推入，支持后退/前进 */
  navHistory: FuncId[];
  /** 当前在历史中的位置（-1 表示不在历史中） */
  navIndex: number;
  ctxMenu: CtxMenu | null;
  /** 导航历史：每次选中函数时推入，支持后退/前进 */
  /** 当前在历史中的位置（-1 表示不在历史中） */

  loadFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  addFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  removeFiles: (paths: string[]) => Promise<void>;
  setActiveFile: (path: string) => void;
  selectFromCode: (funcId: FuncId | null) => void;
  selectFromGraph: (funcId: FuncId) => void;
  /** 点击图上的边：再点同一条边会循环切到下一个调用点；backward（Shift+点）反向 */
  selectEdgeFromGraph: (source: FuncId, target: FuncId, backward?: boolean) => void;
  /** 点击代码里的调用点：反向点亮对应的边，但不驱动代码区滚动 */
  selectEdgeFromCode: (source: FuncId, target: FuncId, index: number) => void;
  /** 调用点步进器：+1 / -1，循环绕回 */
  stepEdge: (delta: number) => void;
  clearEdgeSelection: () => void;
  setScope: (scope: Scope) => void;
  setSplitRatio: (ratio: number) => void;
  setView: (patch: Partial<ViewState>) => void;
  fitView: () => void;
  navBack: () => void;
  navForward: () => void;
  restoreSession: () => Promise<void>;
  reset: () => Promise<void>;
  setCtxMenu: (menu: CtxMenu | null) => void;
}

function pickActiveFile(current: string | null, files: PyFile[]): string | null {
  if (current && files.some((f) => f.path === current)) return current;
  return files[0]?.path ?? null;
}

/**
 * 边选中的 nonce 由模块级计数器提供，而不是存在 state 里再从 null 重新起算：
 * clearEdgeSelection / reset 之后重新点边，nonce 也必须比上一次大，
 * 否则代码区 effect 的「nonce 没变就不滚动」判断会把这次点击当成重复事件吞掉。
 */
let edgeNonce = 0;

/**
 * 按 (source, target, index) 组装一条边选中，并把 activeFile 切到调用点所在文件。
 * 边不存在或没有调用点（图还没算出来）时返回 null，调用方据此保持原状态。
 */
function projectEdge(
  state: AppStore,
  source: FuncId,
  target: FuncId,
  index: number,
  origin: EdgeOrigin,
): Pick<AppStore, 'edgeSelection' | 'activeFile'> | null {
  const sites = sortedCallSites(findEdge(state.graph, source, target));
  if (sites.length === 0) return null;
  const clamped = index >= 0 && index < sites.length ? index : 0;
  const site = sites[clamped] as CallSite;
  return {
    edgeSelection: { source, target, index: clamped, count: sites.length, origin, nonce: ++edgeNonce },
    activeFile: state.files.some((f) => f.path === site.file) ? site.file : state.activeFile,
  };
}

export const useAppStore = create<AppStore>()((set, get) => {
  const runAnalysis = async (picked: PickedFile[], parser?: PythonParser | null): Promise<void> => {
    set({ status: 'loading-wasm', error: null, warnings: [], progress: { done: 0, total: picked.length } });
    if (picked.length === 0) {
      set({
        files: [],
        analyses: [],
        highlights: new Map(),
        graph: null,
        status: 'idle',
        activeFile: null,
        selection: NO_SELECTION,
        edgeSelection: null,
        scope: ALL_SCOPE,
        progress: { done: 0, total: 0 },
      });
      return;
    }
    try {
      const p = parser ?? get().parser ?? (await getParser());
      set({ parser: p, status: 'parsing' });
      const pyFiles = picked.map((f) => makePyFile(f.path, f.name, f.content, f.error));
      const result = await analyzeFiles(pyFiles, p, {
        onProgress: (pr) => set({ progress: { done: pr.done, total: pr.total } }),
      });
      const failed = result.files.filter((f) => f.error);
      set({
        files: result.files,
        analyses: result.analyses,
        highlights: result.highlights,
        graph: result.graph,
        status: 'ready',
        progress: { done: result.files.length, total: result.files.length },
        activeFile: pickActiveFile(get().activeFile, result.files),
        error:
          failed.length > 0 && failed.length === result.files.length
            ? 'All files failed to parse. Please check that the files are valid Python text.'
            : null,
        warnings: failed.map((f) => `${f.name}：${f.error ?? 'Unknown error'}`),
        selection: NO_SELECTION,
        edgeSelection: null,
        scope: ALL_SCOPE,
        view: IDENTITY_VIEW,
        fitNonce: get().fitNonce + 1,
      });
    // 持久化到 IndexedDB
    void saveSession(
      get().files.map((f) => ({ path: f.path, name: f.name, content: f.content, error: f.error })),
      get().activeFile,
    );
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return {
    files: [],
    analyses: [],
    highlights: new Map(),
    graph: null,
    status: 'idle',
    error: null,
    warnings: [],
    progress: { done: 0, total: 0 },
    activeFile: null,
    selection: NO_SELECTION,
    edgeSelection: null,
    scope: ALL_SCOPE,
    splitRatio: DEFAULT_SPLIT,
    view: IDENTITY_VIEW,
    fitNonce: 0,
    parser: null,
    navHistory: [],
    navIndex: -1,
    ctxMenu: null,

    loadFiles: async (files, parser) => {
      if (files.length > MAX_FILES) {
        set({ error: `Too many files: ${files.length}/${MAX_FILES}. Please remove some files before adding more.` });

        return;
      }
      await runAnalysis(files, parser);
    },

    addFiles: async (files, parser) => {
      const existing: PickedFile[] = get()
        .files.map((f) => ({ path: f.path, name: f.name, content: f.content, error: f.error }));
      const incoming = files.map((f) => ({ ...f }));
      const byPath = new Map<string, PickedFile>();
      for (const f of [...existing, ...incoming]) byPath.set(f.path, f);
      const merged = [...byPath.values()];
      if (merged.length > MAX_FILES) {
        set({ error: `Too many files: ${merged.length}/${MAX_FILES}. Please remove some files before adding more.` });
        return;
      }
      await runAnalysis(merged, parser);
    },

    removeFile: async (path) => {
      const rest = get()
        .files.filter((f) => f.path !== path)
        .map((f) => ({ path: f.path, name: f.name, content: f.content, error: f.error }));
      await runAnalysis(rest, get().parser);
    },

    removeFiles: async (paths) => {
      const pathSet = new Set(paths);
      const rest = get()
        .files.filter((f) => !pathSet.has(f.path))
        .map((f) => ({ path: f.path, name: f.name, content: f.content, error: f.error }));
      await runAnalysis(rest, get().parser);
    },

    setActiveFile: (path) => {
      if (get().activeFile === path) return;
      set({ activeFile: path });
    },

    selectFromCode: (funcId) =>
      set((state) => {
        const nonce = state.selection.nonce + 1;
        if (!funcId) return { selection: { funcId: null, source: 'code', nonce }, edgeSelection: null };
        const scoped = state.graph
          ? applyScope(state.graph, state.scope)
          : null;
        const visible = !!scoped && scopeContains(scoped, funcId);
        // 推入导航历史：截断当前位置之后的历史，再追加新项
        const nextHistory = state.navIndex >= 0
          ? [...state.navHistory.slice(0, state.navIndex + 1), funcId]
          : [funcId];
        return {
          selection: { funcId, source: 'code', nonce },
          edgeSelection: null,
          scope: visible ? state.scope : neighborhoodScope(funcId),
          navHistory: nextHistory,
          navIndex: nextHistory.length - 1,
        };
      }),

    selectFromGraph: (funcId) =>
      set((state) => {
        const file = funcFile(funcId);
        const nextScope =
          state.scope.kind === 'neighborhood'
            ? neighborhoodScope(funcId, state.scope.depth)
            : state.scope;
        // 推入导航历史
        const nextHistory = state.navIndex >= 0
          ? [...state.navHistory.slice(0, state.navIndex + 1), funcId]
          : [funcId];
        return {
          selection: { funcId, source: 'graph', nonce: state.selection.nonce + 1 },
          edgeSelection: null,
          scope: nextScope,
          activeFile: file && state.files.some((f) => f.path === file) ? file : state.activeFile,
          navHistory: nextHistory,
          navIndex: nextHistory.length - 1,
        };
      }),

    selectEdgeFromGraph: (source, target, backward) =>
      set((state) => {
        const sites = sortedCallSites(findEdge(state.graph, source, target));
        if (sites.length === 0) return state;
        const prev = state.edgeSelection;
        const same = !!prev && prev.source === source && prev.target === target;
        const from = same && prev && prev.index >= 0 && prev.index < sites.length ? prev.index : -1;
        // 同一条边：往前走一步（Shift 往后），到头绕回；换边：从第一处开始
        const index = from < 0 ? 0 : (from + (backward ? -1 : 1) + sites.length) % sites.length;
        const next = projectEdge(state, source, target, index, 'graph');
        return next ?? state;
      }),

    selectEdgeFromCode: (source, target, index) =>
      set((state) => {
        const next = projectEdge(state, source, target, index, 'code');
        return next ?? state;
      }),

    stepEdge: (delta) =>
      set((state) => {
        const prev = state.edgeSelection;
        if (!prev) return state;
        const sites = sortedCallSites(findEdge(state.graph, prev.source, prev.target));
        if (sites.length === 0) return { edgeSelection: null };
        const from = prev.index >= 0 && prev.index < sites.length ? prev.index : 0;
        const index = (from + (delta < 0 ? -1 : 1) + sites.length) % sites.length;
        const next = projectEdge(state, prev.source, prev.target, index, 'graph');
        return next ?? state;
      }),

    clearEdgeSelection: () => set((state) => (state.edgeSelection ? { edgeSelection: null } : state)),

    setScope: (scope) =>
      set((state) => {
        const scoped = state.graph
          ? applyScope(state.graph, scope)
          : null;
        const keep =
          !!state.selection.funcId && !!scoped && scopeContains(scoped, state.selection.funcId);
        return {
          scope,
          fitNonce: state.fitNonce + 1,
          selection: keep
            ? state.selection
            : { funcId: null, source: 'scope', nonce: state.selection.nonce },
          // 切范围 = 整张图重画，边高亮与代码区打点跟着清掉：一次只有一个焦点（README 与 ADR-0005 的口径）
          edgeSelection: null,
        };
      }),


    setSplitRatio: (ratio) => set({ splitRatio: clampSplit(ratio) }),

    setView: (patch) => set((state) => ({ view: { ...state.view, ...patch } })),

    fitView: () => set((state) => ({ fitNonce: state.fitNonce + 1 })),

    navBack: () =>
      set((state) => {
        if (state.navIndex <= 0) return state;
        const prevId = state.navHistory[state.navIndex - 1] ?? null;
        if (!prevId) return state;
        const file = funcFile(prevId);
        return {
          selection: { funcId: prevId, source: 'nav', nonce: state.selection.nonce + 1 },
          edgeSelection: null,
          activeFile: file && state.files.some((f) => f.path === file) ? file : state.activeFile,
          navIndex: state.navIndex - 1,
        };
      }),

    navForward: () =>
      set((state) => {
        if (state.navIndex < 0 || state.navIndex >= state.navHistory.length - 1) return state;
        const nextId = state.navHistory[state.navIndex + 1] ?? null;
        if (!nextId) return state;
        const file = funcFile(nextId);
        return {
          selection: { funcId: nextId, source: 'nav', nonce: state.selection.nonce + 1 },
          edgeSelection: null,
          activeFile: file && state.files.some((f) => f.path === file) ? file : state.activeFile,
          navIndex: state.navIndex + 1,
        };
      }),

    restoreSession: async () => {
      // 如果已经有文件了（比如测试预设），不要覆盖
      if (get().files.length > 0) return;
      const session = await loadSession();
      if (session && session.files.length > 0) {
        await get().loadFiles(session.files, get().parser);
        if (session.activeFile) {
          const files = get().files;
          if (files.some((f) => f.path === session.activeFile)) {
            useAppStore.setState({ activeFile: session.activeFile });
          }
        }
      }
    },

    setCtxMenu: (menu) => set({ ctxMenu: menu }),

    reset: async () => {
      await clearSession();
      set((state) => ({
        files: [],
        analyses: [],
        highlights: new Map(),
        graph: null,
        status: 'idle',
        error: null,
        warnings: [],
        progress: { done: 0, total: 0 },
        activeFile: null,
        selection: NO_SELECTION,
        edgeSelection: null,
        scope: ALL_SCOPE,
        view: IDENTITY_VIEW,
        fitNonce: state.fitNonce + 1,
        navHistory: [],
        navIndex: -1,
        ctxMenu: null,
      }));
    },
  };
});






