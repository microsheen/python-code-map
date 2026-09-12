/**
 * 解析层的公共数据模型。所有跨模块传递的结构都在这里定义。
 *
 * 坐标约定（全项目统一）：
 * - line / row 一律 1-based（给人看的行号）
 * - column / col 一律 0-based（给编辑器用的列号）
 * - tree-sitter 原生是 0-based row，进入本层时统一 +1
 */

/** 函数唯一标识：`${filePath}::${qualifiedName}` */
export type FuncId = string;

/** 上传阶段拿到的原始文件（filePick 的产物） */
export interface PickedFile {
  path: string;
  name: string;
  content: string;
  /** 读取/解码失败的原因；有此字段的文件不参与解析 */
  error?: string;
}

export interface PyFile {
  /** 归一化后的路径（'/' 分隔），全局唯一键 */
  path: string;
  /** 文件名，含扩展名 */
  name: string;
  /** 原始文本 */
  content: string;
  /** content.split('\n')，0-based 下标对应 line-1 */
  lines: string[];
  /** 该文件解析失败时的原因；有此字段的文件不参与建图 */
  error?: string;
}

export type FuncKind = 'function' | 'method' | 'async';

export interface NameRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FuncSymbol {
  id: FuncId;
  file: string;
  /** 简单名，如 run；模块级伪函数为 <module> */
  name: string;
  /** 限定名，如 BatchRunner.run / outer.inner / <module> */
  qualifiedName: string;
  kind: FuncKind;
  /** def 关键字所在行（1-based），图 -> 代码定位的目标行 */
  defLine: number;
  /** 函数体起始行，含装饰器（1-based） */
  startLine: number;
  /** 函数体结束行（1-based，含最后一行） */
  endLine: number;
  /** 函数名 token 的位置，用于代码区可点击区域 */
  nameRange: NameRange;
  /** 参数原文列表，如 ['self', 'x: int', 'y=3'] */
  params: string[];
  /** 装饰器名（不含 @） */
  decorators: string[];
  /** 所属类名；模块级/嵌套函数为 null */
  className: string | null;
  /** 作用域嵌套深度：0 = 模块级 */
  depth: number;
  /** 是否为合成的 <module> 伪函数（无连边时会被建图阶段丢弃） */
  synthetic?: boolean;
}

export interface ClassSymbol {
  id: string;
  file: string;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  /** 直接基类的原文 */
  bases: string[];
}

export type UnresolvedReason = 'ambiguous' | 'external' | 'dynamic' | 'unknown';
export type CallReason = 'resolved' | UnresolvedReason;

export interface CallSite {
  file: string;
  /** 被调用表达式起始行（1-based） */
  line: number;
  /** 被调用表达式起始列（0-based） */
  column: number;
  /** 被调用表达式原文，如 self.helper / utils.calc */
  text: string;
  /** 发起调用的函数；模块级调用为 <module> 伪函数的 id */
  caller: FuncId | null;
  /** 解析成功时的目标函数 id */
  target: FuncId | null;
  reason: CallReason;
}

export interface CallEdge {
  source: FuncId;
  target: FuncId;
  callSites: CallSite[];
  selfLoop: boolean;
}

export interface GraphStats {
  funcs: number;
  edges: number;
  unresolved: number;
  ms: number;
  /** 各 reason 的未解析调用计数 */
  byReason: Record<UnresolvedReason, number>;
}

export interface CallGraph {
  nodes: FuncSymbol[];
  edges: CallEdge[];
  /** 所有未解析调用点（reason != 'resolved'） */
  unresolved: CallSite[];
  files: string[];
  stats: GraphStats;
}

/** 单个文件的解析产物 */
export interface FileAnalysis {
  file: PyFile;
  funcs: FuncSymbol[];
  classes: ClassSymbol[];
  calls: CallSite[];
  /** 合成的模块级伪函数，承载模块级调用（无边时会被建图阶段丢弃） */
  moduleFunc: FuncSymbol;
  /** tree-sitter 报出的语法错误节点数（容错解析，通常很小） */
  syntaxErrors: number;
}

/** ===== 语法高亮 ===== */

export type TokenScope =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'funcName'
  | 'className'
  | 'decorator'
  | 'operator'
  | 'identifier'
  | 'constant'
  | 'self'
  | 'builtin';

export interface TokenSpan {
  /** 0-based 起始列（含） */
  start: number;
  /** 0-based 结束列（不含） */
  end: number;
  scope: TokenScope;
}

export interface LineTokens {
  /** 1-based 行号 */
  line: number;
  spans: TokenSpan[];
}
export interface AnalysisResult {
  files: PyFile[];
  analyses: FileAnalysis[];
  /** path -> 逐行高亮 token（按内容 hash 缓存） */
  highlights: Map<string, LineTokens[]>;
  graph: CallGraph;
}
