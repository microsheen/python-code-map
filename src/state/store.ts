/**
 * 全局状态（zustand）。
 *
 * 双向定位的关键是 selection.nonce：重复点击同一个节点 / 同一行时 funcId 不变，
 * 靠 nonce 自增让"滚动到行"和"居中"重新触发。
 */
import { create } from 'zustand';
import {
  applyScope,
  neighborhoodScope,
  scopeContains,
  ALL_SCOPE,
  type Scope,
} from '../graph/scope';
import { findEdge, sortedCallSites } from '../graph/edges';
import { analyzeFiles, makePyFile, oversizeMessageOf } from '../parser/analyze';
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
import { webPullTransport } from '../platform/web/pullFetch';
import {
  PULL_TIMEOUT_MS,
  classifyUrl,
  directRequest,
  pulledPathFor,
  splitPastedUrls,
} from '../pull/urls';
import { classifyFailure } from '../pull/errors';
import { pruneBatches, pruneOrigins, upsertBatch } from '../pull/batch';
import type { OriginMap, PullBatch } from '../pull/batch';
import { batchRefreshPlan } from '../pull/refresh';
import { pullOnce, type PullTransport } from '../pull/transport';
import { githubRawUrl, githubSessionPath, type GithubListing } from '../pull/github';
import { createGithubFetchCache, fetchGithubFile, fetchGithubListing } from '../pull/githubFetch';

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
/** 「没有进行中的工作」的进度：分析进度与拉取进度共用这一个零值。 */
const NO_PROGRESS: Progress = { done: 0, total: 0 };

export function funcFile(funcId: FuncId): string {
  const i = funcId.indexOf('::');
  return i < 0 ? '' : funcId.slice(0, i);
}

export function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
}

export interface CtxMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * pullFromText 的可选注入点。
 * transport 是 store 单测的接缝（issue #4「store 既有文件合并通道是第二层接缝（mock 传输）」）；
 * 不传就用 platform/web 那个 fetch 外壳 —— 真 fetch 只有那一个触点。
 */
export interface PullOptions {
  parser?: PythonParser | null;
  transport?: PullTransport;
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

  /** 拉取文件的来源：path -> { url, pulledAt }。本地文件不在里面（这就是它俩的区别）。 */
  origins: OriginMap;
  /** 拉取批次：一个 URL 一个批次，是刷新（#7）的单位；随会话快照持久化 */
  batches: PullBatch[];
  /** 本轮拉取里连文件位置都建不出来的问题（非法 URL 等），一条一句直接给用户看 */
  pullIssues: string[];
  /** 拉取进行中：禁用按钮，免得连点发出重复请求 */
  pulling: boolean;
  /** 拉取粘贴框（顶栏与空态上传面板共用的那个对话框，issue #8）是否打开 */
  pullEntryOpen: boolean;
  /** github 仓库/目录 URL 解析出的候选清单；勾选界面的输入（界面在 #6） */
  pullListing: GithubListing | null;
  /**
   * 一次粘贴多条仓库/目录 URL 时，排在当前清单后面等待确认的清单（issue #8）。
   * pullListing 永远是队头，这里只存队头之后的；确认/关闭一条，下一条顶上来。
   */
  pullQueue: GithubListing[];
  /** 勾选清单确认后的逐文件拉取进度（第 done 个 / 共 total 个）；拉取未进行时 total=0 */
  pullProgress: Progress;

  loadFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  addFiles: (files: PickedFile[], parser?: PythonParser | null) => Promise<void>;
  /**
   * 拉取：粘贴框里的一段文本 -> 一行一个 URL、一个 URL 一个批次、逐批独立成败。
   * 非法 URL 一律不发请求；单文件失败只降级那一个文件，会话既有内容不动。
   */
  pullFromText: (text: string, opts?: PullOptions) => Promise<void>;
  /**
   * 勾选清单确认：把用户选中的那一组仓库相对路径按 raw URL 逐个拉进会话。
   * 一次清单确认 = 一个批次（sourceUrl 就是清单的来源 URL）；逐文件失败走既有坏文件降级路径，
   * 不拖垮整批。selected 为空时什么都不做（也不清清单）。
   */
  confirmPullListing: (selected: string[], opts?: PullOptions) => Promise<void>;
  /**
   * 刷新一个批次（issue #7）：按批次元数据里的原来源与 ref 重放「仍在会话中的该批路径」。
   * 只碰这一批：其他批次不动，删掉的路径不复活；来源 URL 不变，只把拉取时刻推到这一次。
   */
  refreshBatch: (sourceUrl: string, opts?: PullOptions) => Promise<void>;
  /** 关闭勾选清单：不清会话、不发请求；队列里还有下一条就顶上来。 */
  dismissPullListing: () => void;
  /** 打开/关上拉取粘贴框：顶栏入口与空态上传面板入口共用这个开关（issue #8） */
  setPullEntryOpen: (open: boolean) => void;
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
  origin: EdgeOrigin
): Pick<AppStore, 'edgeSelection' | 'activeFile'> | null {
  const sites = sortedCallSites(findEdge(state.graph, source, target));
  if (sites.length === 0) return null;
  const clamped = index >= 0 && index < sites.length ? index : 0;
  const site = sites[clamped] as CallSite;
  return {
    edgeSelection: {
      source,
      target,
      index: clamped,
      count: sites.length,
      origin,
      nonce: ++edgeNonce,
    },
    activeFile: state.files.some((f) => f.path === site.file) ? site.file : state.activeFile,
  };
}

/** 20 文件上限的拒收文案：loadFiles 与 mergeFiles 共用同一句（现有文案，不新写）。 */
function tooManyFilesMessage(count: number): string {
  return `Too many files: ${count}/${MAX_FILES}. Please remove some files before adding more.`;
}

/**
 * 拉进来的条目只有一种形状：有正文，或者带一句 error。直链、github blob、清单逐文件
 * 三种来源共用这一个构造函数，免得「超限句 + 空正文 + 名字」这三件套写三遍。
 */
function pulledEntry(path: string, text: string, error: string | null): PickedFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return error ? { path, name, content: '', error } : { path, name, content: text };
}

/**
 * 勾选清单的配额判据（issue #6），界面与 store 共用同一份。
 * 规则：已在会话里的条目（按 sessionPath 比对）不占新名额，是原位更新；
 * 剩余名额 = MAX_FILES - 当前会话文件数，只用来装「新文件」。
 * 改这条规则只改这里一处，界面（PullListingDialog）与 store（confirmPullListing）同步生效。
 */
export interface ListingQuota {
  remaining: number;
  /** 清单里的仓库相对路径是否已经在会话中（按 sessionPath 比对，命中即原位更新） */
  isExisting: (path: string) => boolean;
}

export function listingQuota(files: { path: string }[], listing: GithubListing): ListingQuota {
  const existing = new Set(files.map((f) => f.path));
  const sessionPathByPath = new Map(listing.entries.map((e) => [e.path, e.sessionPath]));
  return {
    remaining: Math.max(0, MAX_FILES - existing.size),
    isExisting: (path) => {
      const sessionPath = sessionPathByPath.get(path);
      return sessionPath !== undefined && existing.has(sessionPath);
    },
  };
}

export const useAppStore = create<AppStore>()((set, get) => {
  const runAnalysis = async (
    picked: PickedFile[],
    parser?: PythonParser | null,
    opts?: { preserveView?: boolean }
  ): Promise<void> => {
    set({
      status: 'loading-wasm',
      error: null,
      warnings: [],
      progress: { done: 0, total: picked.length },
    });
    if (picked.length === 0) {
      set({
        files: [],
        analyses: [],
        highlights: new Map(),
        graph: null,
        status: 'idle',
        activeFile: null,
        origins: {},
        batches: [],
        pullListing: null,
        pullQueue: [],
        pullProgress: NO_PROGRESS,
        selection: NO_SELECTION,
        edgeSelection: null,
        scope: ALL_SCOPE,
        progress: NO_PROGRESS,
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
      // 来源与批次跟着文件集合一起收敛：会话里已经没有的文件，元数据也不留（不变量 origins ⊆ files）。
      // 删掉一个拉取文件之后它的批次路径也跟着消失 —— 刷新（#7）才不会把它复活。
      const alivePaths = result.files.map((f) => f.path);
      const nextOrigins = pruneOrigins(get().origins, alivePaths);
      const nextBatches = pruneBatches(get().batches, alivePaths);
      set({
        files: result.files,
        origins: nextOrigins,
        batches: nextBatches,
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
        warnings: failed.map((f) => `${f.name}: ${f.error ?? 'Unknown error'}`),
        // preserveView：没有任何新内容进来的那种合并（拉取全失败）不重置用户的
        // 选择/范围/视图 —— 重置在那种情况下是纯损失，不是「有新内容要看」。
        ...(opts?.preserveView
          ? {}
          : {
              selection: NO_SELECTION,
              edgeSelection: null,
              scope: ALL_SCOPE,
              view: IDENTITY_VIEW,
              fitNonce: get().fitNonce + 1,
            }),
      });
      // 持久化到 IndexedDB（含拉取的来源与批次：重开页面内容还在，而还原快照不发任何请求）
      void saveSession(
        get().files.map((f) => ({
          path: f.path,
          name: f.name,
          content: f.content,
          error: f.error,
        })),
        get().activeFile,
        { origins: nextOrigins, batches: nextBatches }
      );
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * 既有的文件合并通道：按 path last-write-wins，超过 MAX_FILES 整体拒掉并沿用现有那句文案。
   *
   * 拉取与本地上传共用这一条通道 —— 拉取文件因此天然是「一等公民」，不需要第二套合并语义
   * （issue #4：同名文件沿用 last-write-wins）。meta 只在合并真的生效时才写进 state，
   * 被上限拒掉时不写：元数据永远不该指向不在会话里的文件。
   */
  const mergeFiles = async (
    incoming: PickedFile[],
    parser?: PythonParser | null,
    meta?: Partial<AppStore>,
    opts?: { preserveView?: boolean }
  ): Promise<boolean> => {
    const existing: PickedFile[] = get().files.map((f) => ({
      path: f.path,
      name: f.name,
      content: f.content,
      error: f.error,
    }));
    const byPath = new Map<string, PickedFile>();
    for (const f of [...existing, ...incoming.map((x) => ({ ...x }))]) byPath.set(f.path, f);
    const merged = [...byPath.values()];
    if (merged.length > MAX_FILES) {
      set({ error: tooManyFilesMessage(merged.length) });
      return false;
    }
    if (meta) set(meta);
    await runAnalysis(merged, parser, opts);
    return true;
  };

  return {
    files: [],
    analyses: [],
    highlights: new Map(),
    graph: null,
    status: 'idle',
    error: null,
    warnings: [],
    progress: NO_PROGRESS,
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
    origins: {},
    batches: [],
    pullIssues: [],
    pulling: false,
    pullEntryOpen: false,
    pullListing: null,
    pullQueue: [],
    pullProgress: NO_PROGRESS,

    loadFiles: async (files, parser) => {
      if (files.length > MAX_FILES) {
        set({ error: tooManyFilesMessage(files.length) });
        return;
      }
      await runAnalysis(files, parser);
    },

    addFiles: async (files, parser) => {
      await mergeFiles(files, parser);
    },

    pullFromText: async (text, opts) => {
      const transport = opts?.transport ?? webPullTransport;
      const lines = splitPastedUrls(text);
      if (lines.length === 0) {
        // 空输入的文案不另写一句：它就是 classifyUrl 的 empty 分支
        const empty = classifyUrl('');
        set({
          pullIssues: empty.kind === 'invalid' ? [empty.message] : [],
          pulling: false,
          pullListing: null,
          pullQueue: [],
          pullProgress: NO_PROGRESS,
        });
        return;
      }
      // 新一次粘贴换掉还挂着的旧清单（含队列）：粘贴框重来就是「上一批不看了」
      set({ pulling: true, pullIssues: [], pullListing: null, pullQueue: [], pullProgress: NO_PROGRESS });
      try {
        const issues: string[] = [];
        // 一次粘贴可能解析出多条清单（每条仓库/目录 URL 一条，issue #8）：排队逐个确认
        const listings: GithubListing[] = [];
        // 逐批合并（issue #11）：每一行先算自己那一批，再单独问一次「放得进去吗」。
        // 放得进去的进 accepted，放不进去的只影响它自己 —— 上限那条失败路径也不例外。
        const accepted: PickedFile[] = [];
        let acceptedPaths = new Set(get().files.map((f) => f.path));
        let origins: OriginMap = { ...get().origins };
        let batches: PullBatch[] = get().batches;
        let overflow: string | null = null;
        const admit = (file: PickedFile, lineOrigins: OriginMap, batch: PullBatch): void => {
          const nextPaths = new Set(acceptedPaths);
          nextPaths.add(file.path);
          if (nextPaths.size > MAX_FILES) {
            // 红条只有一行：只落第一个真正越线的批次，后面的超限批次也按「放不进去」处理
            overflow = overflow ?? tooManyFilesMessage(nextPaths.size);
            return;
          }
          acceptedPaths = nextPaths;
          accepted.push(file);
          origins = { ...origins, ...lineOrigins };
          batches = upsertBatch(batches, batch);
        };
        // 一次粘贴共享一份 ref 解析缓存：同一仓库的多条 blob URL 只查一次分支
        const githubCache = createGithubFetchCache();

        // 逐批独立成败：一批失败不影响后面的批次，也不碰会话里既有的内容
        for (const line of lines) {
          const triage = classifyUrl(line);
          if (triage.kind === 'invalid') {
            // 非法 URL（含 http 明文）：连请求都不发，只把理由给用户
            issues.push(triage.message);
            continue;
          }
          if (triage.kind === 'github') {
            // github 页面 URL 走另一条分流（issue #5）：blob 直接拉单文件，仓库/目录只出清单。
            // 清单本身不是批次：用户勾选之后由 confirmPullListing 逐文件拉取并记成一个批次。
            if (triage.target.kind === 'blob') {
              const file = await fetchGithubFile(triage.target, transport, githubCache);
              // 失败占位也用已解析的拆分：refs 已说 ref=feature/x 时，身份不许退回 x/... 的猜测
              const path = githubSessionPath(triage.target.owner, triage.target.repo, file.path);
              const pulledAt = Date.now();
              const entry = file.ok
                ? pulledEntry(path, file.text, oversizeMessageOf(file.text))
                : pulledEntry(path, '', file.message);
              admit(
                entry,
                { [path]: { url: triage.target.url, pulledAt } },
                {
                  sourceUrl: triage.target.url,
                  // 只记权威解析出的 ref（sha / matching-refs）；首段兜底的猜测不写进批次，
                  // 刷新会按同一规则再拆一次（见 refresh.ts 的 refOf）
                  ref: file.refResolved ? file.ref : null,
                  paths: [path],
                  pulledAt,
                }
              );
              continue;
            }
            const result = await fetchGithubListing(triage.target, transport);
            if (result.ok) listings.push(result.listing);
            else issues.push(result.message);
            continue;
          }
          const path = pulledPathFor(triage.url);
          const outcome = await pullOnce(transport, directRequest(triage.url));
          const pulledAt = Date.now();
          // 超 1MB 的文件不进会话（更不该把几 MB 正文写进 IndexedDB），但占一个带红点的位置，
          // 文案与上传路径共用解析层那一句（#10 之后是英文）：一处判据、一句话。
          // 单文件失败只降级该文件：留一个带 error 的条目，走既有的坏文件降级路径。
          const entry = outcome.ok
            ? pulledEntry(path, outcome.text, oversizeMessageOf(outcome.text))
            : pulledEntry(path, '', classifyFailure(outcome.observation, triage.url).message);
          // 失败也记来源：这个位置确实属于这条 URL，刷新（#7）时要连它一起重试
          admit(
            entry,
            { [path]: { url: triage.url, pulledAt } },
            {
              sourceUrl: triage.url,
              ref: null,
              paths: [path],
              pulledAt,
            }
          );
        }

        if (accepted.length === 0) {
          // 全是非法 URL / 只有清单 / 每一批都撞上限：一个文件都没得合并。这时候走 mergeFiles
          // 会把既有文件白白重解析一遍，顺带把用户当前的选择/范围/视图重置掉。
          set({
            pullIssues: issues,
            pulling: false,
            pullListing: listings[0] ?? null,
            pullQueue: listings.slice(1),
            ...(overflow ? { error: overflow } : {}),
          });
          return;
        }
        const anyContent = accepted.some((f) => !f.error);
        const merged = await mergeFiles(
          accepted,
          opts?.parser,
          {
            origins,
            batches,
            pullIssues: issues,
            pulling: false,
            pullListing: listings[0] ?? null,
            pullQueue: listings.slice(1),
          },
          { preserveView: !anyContent }
        );
        // 撞上 20 文件上限的批次：红条用它自己那一批的计数（mergeFiles 里 runAnalysis 会先清空
        // error，所以这句必须写在合并之后）。
        if (overflow) set({ error: overflow });
        // 合并整体被拒（理论上不会：accepted 已经逐批验过上限）时把拉取状态收干净
        if (!merged)
          set({
            pullIssues: issues,
            pulling: false,
            pullListing: listings[0] ?? null,
            pullQueue: listings.slice(1),
          });
      } finally {
        // 兜底：任何意料之外的异常都不许把 pulling 留成 true（那样按钮会永久禁用）。
        if (get().pulling) set({ pulling: false });
      }
    },

    confirmPullListing: async (selected, opts) => {
      const listing = get().pullListing;
      // 空勾选不是一次拉取：不清清单、不发请求（用户可能只是关掉了没点确认的那一下）
      if (!listing || selected.length === 0) return;
      // 正在拉取（连点确认 / 上一轮还没跑完）就不开第二轮：同一批勾选会被发两遍 GET
      if (get().pulling) return;
      const transport = opts?.transport ?? webPullTransport;
      const picked = new Set(selected);
      // 剩余配额是硬顶：界面已经按它封顶，store 再兜一次，保证会话不会越过 20 个文件。
      // 配额判据只在 listingQuota 里写一份：界面与 store 都从同一个函数拿，改规则不用两头改。
      const quota = listingQuota(get().files, listing);
      let fresh = 0;
      const entries = listing.entries
        .filter((e) => picked.has(e.path) && e.selectable)
        .filter((e) => {
          if (quota.isExisting(e.path)) return true;
          if (fresh >= quota.remaining) return false;
          fresh += 1;
          return true;
        });
      if (entries.length === 0) return;

      const total = entries.length;
      set({ pulling: true, pullIssues: [], pullProgress: { done: 0, total } });
      try {
        const incoming: PickedFile[] = [];
        const origins: OriginMap = { ...get().origins };
        const paths: string[] = [];
        let anyContent = false;
        for (let i = 0; i < total; i += 1) {
          const entry = entries[i] as (typeof entries)[number];
          const url = githubRawUrl(listing.owner, listing.repo, listing.ref, entry.path);
          const outcome = await pullOnce(transport, { url, timeoutMs: PULL_TIMEOUT_MS });
          const pulledAt = Date.now();
          if (outcome.ok) {
            const error = oversizeMessageOf(outcome.text);
            if (!error) anyContent = true;
            incoming.push(pulledEntry(entry.sessionPath, outcome.text, error));
          } else {
            // 单文件失败只降级该文件：走既有的坏文件降级路径，不拖垮整批
            incoming.push(
              pulledEntry(entry.sessionPath, '', classifyFailure(outcome.observation, url).message)
            );
          }
          origins[entry.sessionPath] = { url: listing.sourceUrl, pulledAt };
          paths.push(entry.sessionPath);
          set({ pullProgress: { done: i + 1, total } });
        }
        // 这一批的会话身份：清单来源 URL + 本次确认的勾选集合
        const batches = upsertBatch(get().batches, {
          sourceUrl: listing.sourceUrl,
          ref: listing.ref,
          paths,
          pulledAt: Date.now(),
        });
        const merged = await mergeFiles(
          incoming,
          opts?.parser,
          {
            origins,
            batches,
            pullIssues: [],
            pulling: false,
            pullListing: null,
            pullProgress: { done: total, total },
          },
          { preserveView: !anyContent }
        );
        // 合并生效才轮到下一条清单（issue #8 的队列）；合并被拒时当前清单保留，不丢队列
        if (merged) {
          const [next, ...rest] = get().pullQueue;
          set({ pullListing: next ?? null, pullQueue: rest });
        }
      } finally {
        if (get().pulling) set({ pulling: false });
      }
    },

    refreshBatch: async (sourceUrl, opts) => {
      // 正在拉取（连点刷新 / 上一轮还没跑完）就不开第二轮：同一批文件会被发两遍 GET
      if (get().pulling) return;
      const batch = get().batches.find((b) => b.sourceUrl === sourceUrl);
      if (!batch) return;
      const plan = batchRefreshPlan(batch);
      if (!plan.ok) {
        // 元数据推导不出请求：一条都不发，理由交给用户（与非法 URL 共用同一条告警带）
        set({ pullIssues: [plan.message], pulling: false });
        return;
      }
      // 只重放仍在会话中的路径。批次路径本来就被 runAnalysis 按文件集合裁过，这里按 files
      // 再兜一道：即使将来有别的路径写进批次，刷新也不会替一个不在会话里的文件拉正文。
      const alive = new Set(get().files.map((f) => f.path));
      const requests = plan.requests.filter((r) => alive.has(r.path));
      if (requests.length === 0) return;

      const transport = opts?.transport ?? webPullTransport;
      set({ pulling: true, pullIssues: [] });
      try {
        const origins: OriginMap = { ...get().origins };
        const incoming: PickedFile[] = [];
        const issues: string[] = [];
        let anyContent = false;
        for (const req of requests) {
          const outcome = await pullOnce(transport, { url: req.url, timeoutMs: req.timeoutMs });
          if (!outcome.ok) {
            // 刷新失败不替换已经有内容的文件：一次网络抖动不该把会话里的正文清成占位。
            // 失败理由走告警带；该文件的内容与拉取时刻都停在上一次成功时的样子。
            issues.push(classifyFailure(outcome.observation, req.url).message);
            continue;
          }
          const pulledAt = Date.now();
          const error = oversizeMessageOf(outcome.text);
          if (!error) anyContent = true;
          incoming.push(pulledEntry(req.path, outcome.text, error));
          // 来源 URL 不变：它仍是用户当初给的那条页面/直链地址（github 批次不是 raw 地址），
          // 变的只有拉取时刻 —— 悬浮提示里那句 "Pulled from … at …" 读的就是这两个字段。
          origins[req.path] = { url: origins[req.path]?.url ?? batch.sourceUrl, pulledAt };
        }
        if (incoming.length === 0) {
          // 一条都没刷新成功：不写新内容、不动批次时刻，也不重解析既有会话
          set({ pullIssues: issues, pulling: false });
          return;
        }
        // 批次时刻推到这一次；其他批次原样（「刷新只碰本批」）
        const batches = get().batches.map((b) =>
          b.sourceUrl === sourceUrl ? { ...b, pulledAt: Date.now() } : b
        );
        await mergeFiles(
          incoming,
          opts?.parser,
          { origins, batches, pullIssues: issues, pulling: false },
          // 没有任何新内容进来（只拿到超限正文）时：用户当前的范围/视图不该被重置
          { preserveView: !anyContent }
        );
      } finally {
        if (get().pulling) set({ pulling: false });
      }
    },

    dismissPullListing: () => {
      // 关的只是当前这一条：一次粘贴解析出多条清单时（#8），下一条顶上来继续确认
      const [next, ...rest] = get().pullQueue;
      set({ pullListing: next ?? null, pullQueue: rest, pullProgress: NO_PROGRESS });
    },

    setPullEntryOpen: (open) => set({ pullEntryOpen: open }),

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
        if (!funcId)
          return { selection: { funcId: null, source: 'code', nonce }, edgeSelection: null };
        const scoped = state.graph ? applyScope(state.graph, state.scope) : null;
        const visible = !!scoped && scopeContains(scoped, funcId);
        // 推入导航历史：截断当前位置之后的历史，再追加新项
        const nextHistory =
          state.navIndex >= 0
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
        const nextHistory =
          state.navIndex >= 0
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

    clearEdgeSelection: () =>
      set((state) => (state.edgeSelection ? { edgeSelection: null } : state)),

    setScope: (scope) =>
      set((state) => {
        const scoped = state.graph ? applyScope(state.graph, scope) : null;
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
        // 先把来源与批次放回 state，再走既有的 loadFiles：runAnalysis 会按文件集合裁剪元数据，
        // 顺序反了就会被裁光。旧快照没有这两个字段 -> 一律当本地文件，读入不报错。
        // 这里**不发任何请求**：还原快照只是把内容与元数据读回来（用户故事 10）。
        if (session.origins || session.batches) {
          set({ origins: session.origins ?? {}, batches: session.batches ?? [] });
        }
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
        progress: NO_PROGRESS,
        activeFile: null,
        selection: NO_SELECTION,
        edgeSelection: null,
        scope: ALL_SCOPE,
        view: IDENTITY_VIEW,
        fitNonce: state.fitNonce + 1,
        navHistory: [],
        navIndex: -1,
        ctxMenu: null,
        origins: {},
        batches: [],
        pullIssues: [],
        pulling: false,
        pullListing: null,
        pullQueue: [],
        pullProgress: NO_PROGRESS,
      }));
    },
  };
});
