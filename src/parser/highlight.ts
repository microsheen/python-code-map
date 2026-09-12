/**
 * 语法高亮：按 tree-sitter 叶子节点类型映射到着色 scope，产出逐行 token span。
 *
 * 不使用 .scm 查询文件，避免 tree-sitter Query API 的版本风险。
 * 结果按 `路径 + 内容 hash` 做模块级缓存。
 */
import { isBuiltinName } from './builtins';
import { kids, walk, isField, type SyntaxNodeLike } from './treeLike';
import type { LineTokens, TokenScope, TokenSpan } from './types';

const KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'exec', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'print', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

const CONSTANTS: ReadonlySet<string> = new Set([
  'none', 'true', 'false', 'None', 'True', 'False', 'NotImplemented', 'Ellipsis',
]);

const STRING_TYPES: ReadonlySet<string> = new Set([
  'string', 'string_start', 'string_content', 'string_end', 'escape_sequence', 'interpolation',
  'concatenated_string',
]);

const NUMBER_TYPES: ReadonlySet<string> = new Set(['integer', 'float', 'imaginary']);

export function scopeOfLeaf(leaf: SyntaxNodeLike): TokenScope {
  const t = leaf.type;
  if (t === 'comment') return 'comment';
  if (STRING_TYPES.has(t)) return 'string';
  if (NUMBER_TYPES.has(t)) return 'number';
  if (CONSTANTS.has(t)) return 'constant';
  if (KEYWORDS.has(t)) return 'keyword';

  const p = leaf.parent;
  if (t === 'decorator' || t === '@') return 'decorator';
  if (p && p.type === 'decorator') return 'decorator';

  if (t === 'identifier') {
    if (p) {
      if (p.type === 'function_definition' && isField(p, 'name', leaf)) return 'funcName';
      if (p.type === 'class_definition' && isField(p, 'name', leaf)) return 'className';
      if (p.type === 'call' && isField(p, 'function', leaf)) return 'funcName';
      if (
        p.type === 'attribute' &&
        isField(p, 'attribute', leaf) &&
        p.parent?.type === 'call' &&
        isField(p.parent, 'function', p)
      ) {
        return 'funcName';
      }
      const text = leaf.text;
      if (text === 'self' || text === 'cls') return 'self';
      if (isBuiltinName(text)) return 'builtin';
    }
    return 'identifier';
  }
  if (/^[A-Za-z_]/.test(t)) return 'identifier';
  return 'operator';
}

/** 把一个跨多行的叶子节点切成每行一个 span。 */
function pushSpans(
  byLine: TokenSpan[][],
  leaf: SyntaxNodeLike,
  scope: TokenScope,
  lines: string[],
): void {
  const r0 = leaf.startPosition.row;
  const c0 = leaf.startPosition.column;
  const r1 = leaf.endPosition.row;
  const c1 = leaf.endPosition.column;
  if (r0 === r1) {
    if (c1 <= c0) return;
    const arr = byLine[r0];
    if (arr) arr.push({ start: c0, end: c1, scope });
    return;
  }
  for (let r = r0; r <= r1; r++) {
    const arr = byLine[r];
    if (!arr) continue;
    const text = lines[r] ?? '';
    const start = r === r0 ? c0 : 0;
    let end = r === r1 ? c1 : text.length;
    if (r === r1 && c1 === 0) continue; // 结束在下一行行首，本行不着色
    end = Math.max(end, start + 1);
    end = Math.min(end, Math.max(text.length, start + 1));
    arr.push({ start, end, scope });
  }
}

/**
 * 合并同一行内相邻且同 scope 的 span。
 *
 * 新版 tree-sitter-python 把一个字符串拆成 string_start / string_content / string_end
 * 三个叶子，不合并的话 "text" 会产出 3 个 span，既让 Text 节点数翻倍，也让
 * 按 (start,end) 断言列范围的测试与视觉上的"一个字符串"不一致。
 */
function mergeAdjacentSpans(spans: TokenSpan[]): TokenSpan[] {
  const out: TokenSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && prev.scope === s.scope && s.start <= prev.end) {
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

export function highlightLines(root: SyntaxNodeLike, lines: string[]): LineTokens[] {
  const byLine: TokenSpan[][] = lines.map(() => []);
  walk(root, (n) => {
    if (kids(n).length > 0) return;
    const text = n.text;
    if (!text || text.trim().length === 0) return;
    const scope = scopeOfLeaf(n);
    if (scope === 'plain') return;
    pushSpans(byLine, n, scope, lines);
  });
  return byLine.map((spans, i) => {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    return { line: i + 1, spans: mergeAdjacentSpans(spans) };
  });
}

/** FNV-1a，够用且无依赖。 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + text.length;
}

const CACHE_MAX = 24;
const cache = new Map<string, LineTokens[]>();

export function cachedHighlight(key: string, compute: () => LineTokens[]): LineTokens[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = compute();
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

export function clearHighlightCache(): void {
  cache.clear();
}