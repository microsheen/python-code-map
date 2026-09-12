/**
 * 解析管线：PyFile[] -> 符号 -> 调用点 -> 调用图 + 高亮。
 *
 * 分批 await 让出主线程，单文件失败只标记该文件 error，不影响其余文件。
 */
import { buildGraph } from '../graph/buildGraph';
import { cachedHighlight, contentHash, highlightLines } from './highlight';
import { buildModuleIndex, normalizePath } from './modules';
import { buildFileScope, collectCalls, type ResolveContext } from './resolveCalls';
import { collectSymbols } from './symbols';
import { walk, type SyntaxNodeLike } from './treeLike';
import type { ParseTree, PythonParser } from './treeSitter';
import type { AnalysisResult, FileAnalysis, LineTokens, PyFile } from './types';

/** 单文件大小上限（按字符数近似 1MB） */
export const MAX_FILE_SIZE = 1024 * 1024;

export interface AnalyzeProgress {
  done: number;
  total: number;
  file: string;
}

export interface AnalyzeOptions {
  onProgress?: (p: AnalyzeProgress) => void;
  /** 每多少个文件让出一次主线程 */
  batchSize?: number;
  /** 让出主线程的实现，测试里可注入 noop */
  yieldControl?: () => Promise<void>;
}

const defaultYield = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function makePyFile(rawPath: string, rawName: string, content: string, error?: string): PyFile {
  const path = normalizePath(rawPath || rawName || 'unnamed.py');
  const text = normalizeNewlines(content ?? '');
  return {
    path,
    name: path.split('/').pop() ?? path,
    content: text,
    lines: text.split('\n'),
    error,
  };
}

/** 归一化 + 去重（同路径后者覆盖前者）+ 大小检查。 */
export function normalizeFiles(input: PyFile[]): PyFile[] {
  const out: PyFile[] = [];
  const indexByPath = new Map<string, number>();
  for (const raw of input) {
    const f: PyFile = { ...raw };
    f.path = normalizePath(raw.path || raw.name);
    if (!f.path) continue;
    if (!f.error) {
      if ((f.content?.length ?? 0) > MAX_FILE_SIZE) {
        f.error = `文件超过 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB，已跳过`;
      }
    }
    f.lines = normalizeNewlines(f.content ?? '').split('\n');
    f.content = normalizeNewlines(f.content ?? '');
    const prev = indexByPath.get(f.path);
    if (prev !== undefined) out[prev] = f;
    else {
      indexByPath.set(f.path, out.length);
      out.push(f);
    }
  }
  return out;
}

function countSyntaxErrors(root: { rootNode: SyntaxNodeLike }): number {
  let n = 0;
  walk(root.rootNode, (node) => {
    // web-tree-sitter 0.27 用 isError / isMissing 布尔 getter 标记错误节点与补全的缺失
    // token（缺失 token 的 type 是真实类型如 ")"，只看 type 前缀会漏计）。
    if (node.type === 'ERROR' || node.isError) n++;
    else if (node.type.startsWith('MISSING') || node.isMissing) n++;
  });
  // 兜底：hasError 为真但没数到（极端容错恢复）时，至少记 1 处。
  if (n === 0 && root.rootNode.hasError) n = 1;
  return n;
}

export function emptyAnalysisResult(): AnalysisResult {
  return {
    files: [],
    analyses: [],
    highlights: new Map<string, LineTokens[]>(),
    graph: { nodes: [], edges: [], unresolved: [], files: [], stats: { funcs: 0, edges: 0, unresolved: 0, ms: 0, byReason: { ambiguous: 0, external: 0, dynamic: 0, unknown: 0 } } },
  };
}

export async function analyzeFiles(
  input: PyFile[],
  parser: PythonParser,
  opts: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const started = Date.now();
  const batchSize = Math.max(1, opts.batchSize ?? 3);
  const yieldControl = opts.yieldControl ?? defaultYield;

  const files = normalizeFiles(input);
  const parseable = files.filter((f) => !f.error);
  const index = buildModuleIndex(parseable.map((f) => f.path));
  const ctx: ResolveContext = { index, files: new Map() };
  const trees = new Map<string, ParseTree>();
  const analyses: FileAnalysis[] = [];
  const highlights = new Map<string, LineTokens[]>();

  // pass 1：解析 + 收集符号（必须先全部完成，跨文件解析才能看到彼此）
  for (let i = 0; i < parseable.length; i++) {
    const f = parseable[i];
    if (!f) continue;
    try {
      const tree = parser.parse(f.content);
      if (!tree) {
        f.error = '解析失败：tree-sitter 返回空树';
      } else {
        trees.set(f.path, tree);
        const root = tree.rootNode;
        const syms = collectSymbols(f.path, root, f.lines.length);
        ctx.files.set(f.path, buildFileScope(f.path, syms, root));
        const syntaxErrors = countSyntaxErrors(tree);
        // 有语法错误时不中断：tree-sitter 已尽力恢复，符号照常入图，
        // 只把该文件标记为 warning（store 里据此显示黄条），其余文件不受影响。
        if (syntaxErrors > 0 && !f.error) {
          f.error = `存在 ${syntaxErrors} 处语法错误，已尽力解析（结果可能不完整）`;
        }
        analyses.push({
          file: f,
          funcs: syms.funcs,
          classes: syms.classes,
          calls: [],
          moduleFunc: syms.moduleFunc,
          syntaxErrors,
        });
      }
    } catch (e) {
      f.error = `解析异常：${e instanceof Error ? e.message : String(e)}`;
    }
    opts.onProgress?.({ done: i + 1, total: parseable.length, file: f.path });
    if ((i + 1) % batchSize === 0) await yieldControl();
  }

  // pass 2：调用解析 + 高亮（都依赖已建好的 tree）
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    if (!a) continue;
    const tree = trees.get(a.file.path);
    if (!tree) continue;
    try {
      a.calls = collectCalls(a.file.path, tree.rootNode, ctx);
      const key = `${a.file.path}@${contentHash(a.file.content)}`;
      const lines = a.file.lines;
      highlights.set(
        a.file.path,
        cachedHighlight(key, () => highlightLines(tree.rootNode, lines)),
      );
    } catch (e) {
      a.file.error = a.file.error ?? `解析异常：${e instanceof Error ? e.message : String(e)}`;
    }
    if ((i + 1) % batchSize === 0) await yieldControl();
  }

  for (const tree of trees.values()) {
    try {
      tree.delete();
    } catch {
      // ignore
    }
  }
  trees.clear();

  const graph = buildGraph(analyses, Date.now() - started);
  return { files, analyses, highlights, graph };
}