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

/** 单文件大小上限：1MB，按 UTF-8 **实际字节数**算（byteLengthOf），不是字符数。 */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * UTF-8 编码后的字节数。
 *
 * 为什么不用 TextEncoder：jest 的 jsdom 环境里没有这个全局量（实测 typeof TextEncoder ===
 * 'undefined'），用它就得在测试里再塞一份 polyfill，于是「测的那条路径」与「跑的那条路径」
 * 不是同一条。这里手算 UTF-8 长度，浏览器与测试走的是同一份代码。
 * 落单的高代理项不是合法 UTF-8，按替换字符的 3 字节计。
 */
export function byteLengthOf(text: string): number {
  const s = text ?? '';
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 超限文案，只此一处：本地上传与拉取两条路径共用同一句（issue #4「沿用现有超限提示文案」）。
 * 这句是中文而仓库口径要求 UI 字符串用英文 —— 它是本票之前就存在的文案，沿用比顺手改写诚实；
 * 要改口径请单独一轮，别夹在功能票里。
 */
export function oversizeMessage(): string {
  return `文件超过 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB，已跳过`;
}

/** 超了上限就返回那句文案，没超返回 null。 */
export function oversizeMessageOf(content: string): string | null {
  return byteLengthOf(content) > MAX_FILE_SIZE ? oversizeMessage() : null;
}

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

export function makePyFile(
  rawPath: string,
  rawName: string,
  content: string,
  error?: string
): PyFile {
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
      const over = oversizeMessageOf(f.content ?? '');
      if (over) f.error = over;
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
    graph: {
      nodes: [],
      edges: [],
      unresolved: [],
      files: [],
      stats: {
        funcs: 0,
        edges: 0,
        unresolved: 0,
        ms: 0,
        byReason: { ambiguous: 0, external: 0, dynamic: 0, unknown: 0 },
      },
    },
  };
}

export async function analyzeFiles(
  input: PyFile[],
  parser: PythonParser,
  opts: AnalyzeOptions = {}
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
        cachedHighlight(key, () => highlightLines(tree.rootNode, lines))
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
