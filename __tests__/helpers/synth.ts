/**
 * 合成数据工厂：纯函数测试与组件测试共用，不依赖 wasm。
 *
 * 这里刻意不用真实的 tree-sitter 结果，目的是让"图 / 状态 / 组件"层的测试
 * 能在任何环境下跑（新克隆没执行 npm run copy-wasm 也一样）。
 */
import { buildGraph } from '../../src/graph/buildGraph';
import { MODULE_FUNC, makeFuncId, moduleId } from '../../src/parser/symbols';
import type {
  CallEdge,
  CallGraph,
  CallReason,
  CallSite,
  FileAnalysis,
  FuncSymbol,
  LineTokens,
  PyFile,
  TokenSpan,
  UnresolvedReason,
} from '../../src/parser/types';

const REASONS: UnresolvedReason[] = ['ambiguous', 'external', 'dynamic', 'unknown'];

/** 造一个函数符号；未显式给出的字段按 q / defLine 推出合理默认值。 */
export function func(file: string, q: string, over: Partial<FuncSymbol> = {}): FuncSymbol {
  const name = over.name ?? (q.split('.').pop() || q);
  const defLine = over.defLine ?? 1;
  const startLine = over.startLine ?? defLine;
  const endLine = over.endLine ?? startLine + 2;
  const base: FuncSymbol = {
    id: makeFuncId(file, q),
    file,
    name,
    qualifiedName: q,
    kind: 'function',
    defLine,
    startLine,
    endLine,
    nameRange: {
      startLine: defLine,
      startCol: 4,
      endLine: defLine,
      endCol: 4 + name.length,
    },
    params: [],
    decorators: [],
    className: q.includes('.') ? (q.split('.')[0] ?? null) : null,
    depth: q.includes('.') ? 1 : 0,
  };
  return { ...base, ...over };
}

/** 合成的模块级伪函数（与 src/parser/symbols.ts 里的形状一致）。 */
export function moduleFunc(file: string, totalLines: number): FuncSymbol {
  return {
    id: moduleId(file),
    file,
    name: MODULE_FUNC,
    qualifiedName: MODULE_FUNC,
    kind: 'function',
    defLine: 1,
    startLine: 1,
    endLine: Math.max(1, totalLines),
    nameRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
    params: [],
    decorators: [],
    className: null,
    depth: 0,
    synthetic: true,
  };
}

export function pyFile(path: string, content: string): PyFile {
  const text = content.replace(/\r\n?/g, '\n');
  return {
    path,
    name: path.split('/').pop() || path,
    content: text,
    lines: text.split('\n'),
  };
}

export function callSite(
  o: Partial<CallSite> & { file: string; line: number; caller: string | null },
): CallSite {
  const target = o.target ?? null;
  const reason: CallReason = o.reason ?? (target ? 'resolved' : 'unknown');
  return {
    file: o.file,
    line: o.line,
    column: o.column ?? 0,
    text: o.text ?? '',
    caller: o.caller,
    target,
    reason,
  };
}

/** 一条边；不给 callSites 时自动补一个，保证 weight 计算不为 0。 */
export function edge(source: string, target: string, sites: CallSite[] = []): CallEdge {
  const callSites =
    sites.length > 0
      ? sites
      : [
          callSite({
            file: source.split('::')[0] ?? '',
            line: 1,
            caller: source,
            target,
            text: target.split('::')[1] ?? '',
          }),
        ];
  return { source, target, callSites, selfLoop: source === target };
}

/** 手工拼图（scope / layout 测试用）。stats 按 nodes/edges/unresolved 现算。 */
export function graphOf(
  nodes: FuncSymbol[],
  edges: CallEdge[],
  unresolved: CallSite[] = [],
  files?: string[],
): CallGraph {
  const byReason: Record<UnresolvedReason, number> = {
    ambiguous: 0,
    external: 0,
    dynamic: 0,
    unknown: 0,
  };
  for (const u of unresolved) {
    if (u.reason !== 'resolved' && REASONS.includes(u.reason as UnresolvedReason)) {
      byReason[u.reason as UnresolvedReason] += 1;
    }
  }
  return {
    nodes,
    edges,
    unresolved,
    files: files ?? [...new Set(nodes.map((n) => n.file).filter((f) => f.length > 0))],
    stats: {
      funcs: nodes.length,
      edges: edges.length,
      unresolved: unresolved.length,
      ms: 0,
      byReason,
    },
  };
}

export function analysisOf(
  file: PyFile,
  funcs: FuncSymbol[],
  calls: CallSite[] = [],
  classes: FileAnalysis['classes'] = [],
): FileAnalysis {
  return {
    file,
    funcs,
    classes,
    calls,
    moduleFunc: moduleFunc(file.path, file.lines.length),
    syntaxErrors: 0,
  };
}

/** 走真实的 buildGraph，保证聚合 / 统计逻辑与线上一致。 */
export function graphFromAnalyses(analyses: FileAnalysis[], ms = 0): CallGraph {
  return buildGraph(analyses, ms);
}

export function tokens(line: number, spans: TokenSpan[]): LineTokens {
  return { line, spans };
}

export function span(start: number, end: number, scope: TokenSpan['scope']): TokenSpan {
  return { start, end, scope };
}
