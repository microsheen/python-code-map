/**
 * 全局状态（zustand）。
 *
 * 双向定位的关键是 selection.nonce：重复点击同一个节点 / 同一行时 funcId 不变，
 * 靠 nonce 自增让"滚动到行"和"居中"重新触发。
 */
import { create } from 'zustand';
import { applyScope, neighborhoodScope, scopeContains, ALL_SCOPE, type Scope } from '../graph/scope';
import { analyzeFiles, makePyFile } from '../parser/analyze';
import { getParser, type PythonParser } from '../parser/treeSitter';
import type {
  CallGraph,
  FileAnalysis,
  FuncId,
  LineTokens,
  PickedFile,
  PyFile,
} from '../parser/types';

export type SelectionSource = 'code' | 'graph' | 'scope';

export interface Selection {
  funcId: FuncId | null;
  source: SelectionSource;
  /** 每次选中都 +1，用于重复点击时重新触发定位动画 */
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
export const DEFAULT_SPLIT = 0.45;
export const MIN_SPLIT = 0.25;
export const MAX_SPLIT = 0.75;
export const NO_SELECTION: Selection = { funcId: null, source: 'scope', nonce: 0 };

export function funcFile(funcId: FuncId): string {
  const i = funcId.indexOf('::');
  return i < 0 ? '' : funcId.slice(0, i);
}

export function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
}

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
  scope: Scope;
  showExternal: boolean;
  splitRatio: number;
  view: ViewState;
  /** +1 表示"请重新适应窗口" */
  fitNonce: number;
  parser: PythonParser | null;

  loadFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  addFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  setActiveFile: (path: string) => void;
  selectFromCode: (funcId: FuncId | null) => void;
  selectFromGraph: (funcId: FuncId) => void;
  setScope: (scope: Scope) => void;
  setShowExternal: (value: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  setView: (patch: Partial<ViewState>) => void;
  fitView: () => void;
  reset: () => void;
}

function pickActiveFile(current: string | null, files: PyFile[]): string | null {
  if (current && files.some((f) => f.path === current)) return current;
  return files[0]?.path ?? null;
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
            ? '所有文件都解析失败，请检查文件是否为合法的 Python 文本'
            : null,
        warnings: failed.map((f) => `${f.name}：${f.error ?? '未知错误'}`),
        selection: NO_SELECTION,
        scope: ALL_SCOPE,
        view: IDENTITY_VIEW,
        fitNonce: get().fitNonce + 1,
      });
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
    scope: ALL_SCOPE,
    showExternal: false,
    splitRatio: DEFAULT_SPLIT,
    view: IDENTITY_VIEW,
    fitNonce: 0,
    parser: null,

    loadFiles: (files, parser) => runAnalysis(files, parser),

    addFiles: async (files, parser) => {
      const existing: PickedFile[] = get()
        .files.map((f) => ({ path: f.path, name: f.name, content: f.content, error: f.error }));
      const incoming = files.map((f) => ({ ...f }));
      const byPath = new Map<string, PickedFile>();
      for (const f of [...existing, ...incoming]) byPath.set(f.path, f);
      await runAnalysis([...byPath.values()], parser);
    },

    removeFile: async (path) => {
      const rest = get()
        .files.filter((f) => f.path !== path)
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
        if (!funcId) return { selection: { funcId: null, source: 'code', nonce } };
        const scoped = state.graph
          ? applyScope(state.graph, state.scope, { showExternal: state.showExternal })
          : null;
        const visible = !!scoped && scopeContains(scoped, funcId);
        return {
          selection: { funcId, source: 'code', nonce },
          // 目标不在当前范围内时自动切到它的邻域，否则右侧没法居中
          scope: visible ? state.scope : neighborhoodScope(funcId),
        };
      }),

    selectFromGraph: (funcId) =>
      set((state) => {
        const file = funcFile(funcId);
        const nextScope =
          state.scope.kind === 'neighborhood'
            ? neighborhoodScope(funcId, state.scope.depth)
            : state.scope;
        return {
          selection: { funcId, source: 'graph', nonce: state.selection.nonce + 1 },
          scope: nextScope,
          activeFile: file && state.files.some((f) => f.path === file) ? file : state.activeFile,
        };
      }),

    setScope: (scope) =>
      set((state) => {
        const scoped = state.graph
          ? applyScope(state.graph, scope, { showExternal: state.showExternal })
          : null;
        const keep =
          !!state.selection.funcId && !!scoped && scopeContains(scoped, state.selection.funcId);
        return {
          scope,
          fitNonce: state.fitNonce + 1,
          selection: keep
            ? state.selection
            : { funcId: null, source: 'scope', nonce: state.selection.nonce },
        };
      }),

    setShowExternal: (value) =>
      set((state) => ({ showExternal: value, fitNonce: state.fitNonce + 1 })),

    setSplitRatio: (ratio) => set({ splitRatio: clampSplit(ratio) }),

    setView: (patch) => set((state) => ({ view: { ...state.view, ...patch } })),

    fitView: () => set((state) => ({ fitNonce: state.fitNonce + 1 })),

    reset: () =>
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
        scope: ALL_SCOPE,
        view: IDENTITY_VIEW,
        fitNonce: state.fitNonce + 1,
      })),
  };
});