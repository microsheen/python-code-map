/**
 * tree-sitter SyntaxNode 的最小子集。
 *
 * 解析层只依赖这个接口，不直接 import web-tree-sitter 的类型，
 * 这样纯函数层可以在任何环境下测试，也不受 web-tree-sitter 版本 API 变动影响。
 */
export interface PointLike {
  row: number;
  column: number;
}

export interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly startPosition: PointLike;
  readonly endPosition: PointLike;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly children: SyntaxNodeLike[];
  readonly namedChildren: SyntaxNodeLike[];
  readonly parent: SyntaxNodeLike | null;
  /** tree-sitter：该子树内是否存在语法错误（ERROR / MISSING） */
  readonly hasError?: boolean;
  /** tree-sitter：该节点本身是否为语法错误节点（ERROR） */
  readonly isError?: boolean;
  /** tree-sitter：该节点是否为解析器自动补全的缺失 token（MISSING） */
  readonly isMissing?: boolean;
  childForFieldName(name: string): SyntaxNodeLike | null;
  child(index: number): SyntaxNodeLike | null;
  namedChild(index: number): SyntaxNodeLike | null;
  /**
   * 可选：取某字段的**全部**子节点（`from m import a, b` 这种重复字段）。
   * web-tree-sitter 有这个方法，测试里的假树可以只实现 childForFieldName。
   */
  childrenForFieldName?(name: string): SyntaxNodeLike[];
}

/**
 * web-tree-sitter 的 children / namedChildren 里可能混入 null，
 * 统一用这两个函数过滤，避免运行时炸。
 */
export function kids(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const out: SyntaxNodeLike[] = [];
  const raw = node.children as (SyntaxNodeLike | null)[] | null;
  if (raw) for (const k of raw) if (k) out.push(k);
  return out;
}

export function namedKids(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const out: SyntaxNodeLike[] = [];
  const raw = node.namedChildren as (SyntaxNodeLike | null)[] | null;
  if (raw) for (const k of raw) if (k) out.push(k);
  return out;
}

/** 深度优先遍历（含匿名节点）。visit 返回 false 可剪枝（不再深入子节点）。 */
export function walk(node: SyntaxNodeLike, visit: (n: SyntaxNodeLike) => boolean | void): void {
  const stack: SyntaxNodeLike[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    const keepGoing = visit(cur);
    if (keepGoing === false) continue;
    const ch = kids(cur);
    for (let i = ch.length - 1; i >= 0; i--) {
      const k = ch[i];
      if (k) stack.push(k);
    }
  }
}

/** 取字段子节点；字段不存在时按类型兜底查找。 */
export function field(
  node: SyntaxNodeLike,
  name: string,
  fallbackTypes?: string[],
): SyntaxNodeLike | null {
  const direct = node.childForFieldName(name);
  if (direct) return direct;
  if (!fallbackTypes) return null;
  for (const kid of namedKids(node)) {
    if (fallbackTypes.includes(kid.type)) return kid;
  }
  return null;
}

/** 判断某个子节点是不是指定字段（用 startIndex 比，web-tree-sitter 每次返回新包装对象）。 */
export function isField(node: SyntaxNodeLike, fieldName: string, child: SyntaxNodeLike): boolean {
  const f = node.childForFieldName(fieldName);
  return !!f && f.startIndex === child.startIndex && f.endIndex === child.endIndex;
}

/**
 * 取某个字段的**全部**子节点。
 *
 * `childForFieldName` 只返回第一个匹配（`from m import a, b` 里的 a），
 * 这里优先用 `childrenForFieldName`；假树没有该方法时退化到"只有一个"，
 * 调用方需要自己给出位置兜底（见 imports.ts）。
 */
export function fieldChildren(node: SyntaxNodeLike, fieldName: string): SyntaxNodeLike[] {
  const out: SyntaxNodeLike[] = [];
  if (typeof node.childrenForFieldName === 'function') {
    const raw = node.childrenForFieldName(fieldName) as (SyntaxNodeLike | null)[] | null;
    if (raw) for (const k of raw) if (k) out.push(k);
    if (out.length > 0) return out;
  }
  const one = node.childForFieldName(fieldName);
  if (one) out.push(one);
  return out;
}

/** 向上找指定类型的祖先。 */
export function ancestorOfType(
  node: SyntaxNodeLike | null,
  types: string[],
): SyntaxNodeLike | null {
  let cur = node?.parent ?? null;
  while (cur) {
    if (types.includes(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** 把 dotted_name / attribute 链拼成点号字符串；不是纯点号链时返回 null。 */
export function dottedText(node: SyntaxNodeLike | null): string | null {
  if (!node) return null;
  if (
    node.type === 'dotted_name' ||
    node.type === 'identifier' ||
    node.type === 'none' ||
    node.type === 'type'
  ) {
    return node.text;
  }
  if (node.type === 'attribute') {
    const obj = node.childForFieldName('object');
    const attr = node.childForFieldName('attribute');
    const left = dottedText(obj);
    if (left === null || !attr) return null;
    return left + '.' + attr.text;
  }
  return null;
}

/** 节点结束行（1-based）。endPosition.column === 0 表示结束在行首，不再 +1。 */
export function endLineOf(node: SyntaxNodeLike): number {
  const { row, column } = node.endPosition;
  const line = column === 0 ? row : row + 1;
  return Math.max(1, line);
}

/** 节点起始行（1-based）。 */
export function startLineOf(node: SyntaxNodeLike): number {
  return node.startPosition.row + 1;
}
