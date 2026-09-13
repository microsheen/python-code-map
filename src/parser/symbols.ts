/**
 * 函数 / 类符号收集（带作用域栈）。
 *
 * 覆盖：模块级函数、async def、类方法（Class.method）、嵌套函数（Outer.inner）、
 * 装饰器、参数列表、精确的行列范围。
 */
import {
  dottedText,
  endLineOf,
  kids,
  namedKids,
  startLineOf,
  type SyntaxNodeLike,
} from './treeLike';
import type { ClassSymbol, FuncSymbol, NameRange } from './types';

export const MODULE_FUNC = '<module>';

export function makeFuncId(file: string, qualifiedName: string): string {
  return `${file}::${qualifiedName}`;
}

export function moduleId(file: string): string {
  return makeFuncId(file, MODULE_FUNC);
}

export interface FileSymbols {
  funcs: FuncSymbol[];
  classes: ClassSymbol[];
  /** 合成的模块级伪函数，承载模块级调用 */
  moduleFunc: FuncSymbol;
}

interface ScopeEntry {
  kind: 'func' | 'class';
  name: string;
  node: SyntaxNodeLike;
}

function nameRangeOf(node: SyntaxNodeLike): NameRange {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.column === 0 ? node.endPosition.row : node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function keywordLine(node: SyntaxNodeLike, keyword: string): number {
  for (const k of kids(node)) {
    if (k.type === keyword) return k.startPosition.row + 1;
  }
  return startLineOf(node);
}

function collectParams(paramsNode: SyntaxNodeLike | null): string[] {
  if (!paramsNode) return [];
  const out: string[] = [];
  for (const p of namedKids(paramsNode)) {
    const t = p.text.trim();
    if (t) out.push(t);
  }
  return out;
}

function collectDecorators(node: SyntaxNodeLike): string[] {
  if (node.type !== 'decorated_definition') return [];
  const out: string[] = [];
  for (const kid of namedKids(node)) {
    if (kid.type !== 'decorator') continue;
    const inner = namedKids(kid)[0];
    if (!inner) continue;
    if (inner.type === 'call') {
      const fn = inner.childForFieldName('function');
      const d = dottedText(fn);
      out.push(d ?? fn?.text ?? inner.text);
    } else {
      const d = dottedText(inner);
      out.push(d ?? inner.text);
    }
  }
  return out;
}

function collectBases(node: SyntaxNodeLike): string[] {
  const sc = node.childForFieldName('superclasses');
  if (!sc) return [];
  const out: string[] = [];
  for (const b of namedKids(sc)) {
    if (b.type === 'keyword_argument') {
      const nm = b.childForFieldName('name');
      const v = b.childForFieldName('value');
      out.push(`${nm?.text ?? '?'}=${v?.text ?? '?'}`);
      continue;
    }
    const d = dottedText(b);
    out.push(d ?? b.text);
  }
  return out;
}

/**
 * Scan class body for self.attr = ClassName(...) patterns.
 */
function collectSelfAssignments(classBody: SyntaxNodeLike): Record<string, string> {
  const types: Record<string, string> = {};
  const ambiguous = new Set<string>();

  const walk = (node: SyntaxNodeLike): void => {
    for (const kid of namedKids(node)) {
      if (kid.type === 'function_definition' || kid.type === 'class_definition') continue;
      if (kid.type === 'decorated_definition') {
        const inner = kid.childForFieldName('definition');
        if (inner && inner.type === 'function_definition') {
          const body = inner.childForFieldName('body');
          if (body) walk(body);
        }
        continue;
      }
      if (kid.type === 'assignment') {
        const left = kid.childForFieldName('left');
        const right = kid.childForFieldName('right');
        if (left && left.type === 'attribute' && right && right.type === 'call') {
          const obj = left.childForFieldName('object');
          const attr = left.childForFieldName('attribute');
          const fn = right.childForFieldName('function');
          if (obj && obj.text === 'self' && attr && attr.type === 'identifier' && fn && fn.type === 'identifier') {
            const attrName = attr.text;
            const className = fn.text;
            if (ambiguous.has(attrName)) {
              // skip
            } else if (attrName in types && types[attrName] !== className) {
              delete types[attrName];
              ambiguous.add(attrName);
            } else {
              types[attrName] = className;
            }
          }
        }
      }
      walk(kid);
    }
  };

  walk(classBody);
  return types;
}

export function collectSymbols(file: string, root: SyntaxNodeLike, totalLines: number): FileSymbols {
  const funcs: FuncSymbol[] = [];
  const classes: ClassSymbol[] = [];
  const moduleFunc: FuncSymbol = {
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

  const visit = (node: SyntaxNodeLike, stack: ScopeEntry[]): void => {
    for (const kid of namedKids(node)) {
      if (kid.type === 'decorated_definition') {
        const def = kid.childForFieldName('definition');
        if (def) handleDef(def, stack, kid);
        continue;
      }
      if (kid.type === 'function_definition' || kid.type === 'class_definition') {
        handleDef(kid, stack, null);
        continue;
      }
      visit(kid, stack);
    }
  };

  const handleDef = (
    node: SyntaxNodeLike,
    stack: ScopeEntry[],
    decorated: SyntaxNodeLike | null,
  ): void => {
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text ?? '<anonymous>';
    const qName = [...stack.map((s) => s.name), name].join('.');
    const startLine = decorated ? startLineOf(decorated) : startLineOf(node);
    const endLine = Math.max(startLine, endLineOf(node));

    if (node.type === 'class_definition') {
      const body = node.childForFieldName('body');
      classes.push({
        id: makeFuncId(file, qName),
        file,
        name,
        qualifiedName: qName,
        startLine,
        endLine,
        bases: collectBases(node),
        instanceAttrs: body ? collectSelfAssignments(body) : {},
      });
      if (body) visit(body, [...stack, { kind: 'class', name, node }]);
      return;
    }

    // function_definition
    let className: string | null = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      if (s && s.kind === 'class') {
        className = s.name;
        break;
      }
    }
    const isAsync = kids(node).some((k) => k.type === 'async');
    funcs.push({
      id: makeFuncId(file, qName),
      file,
      name,
      qualifiedName: qName,
      kind: isAsync ? 'async' : className ? 'method' : 'function',
      defLine: keywordLine(node, 'def'),
      startLine,
      endLine,
      nameRange: nameNode ? nameRangeOf(nameNode) : { startLine, startCol: 0, endLine: startLine, endCol: 0 },
      params: collectParams(node.childForFieldName('parameters')),
      decorators: decorated ? collectDecorators(decorated) : [],
      className,
      depth: stack.length,
    });
    const body = node.childForFieldName('body');
    if (body) visit(body, [...stack, { kind: 'func', name, node }]);
  };

  visit(root, []);
  // 按出现顺序排序（visit 已经是源码顺序，这里只是防御）
  funcs.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
  classes.sort((a, b) => a.startLine - b.startLine);
  return { funcs, classes, moduleFunc };
}

/**
 * line(1-based) -> 最内层包含该行的函数。
 * 供代码区"点击函数体内任意行"使用。
 */
export function buildLineOwners(funcs: FuncSymbol[]): Map<number, FuncSymbol> {
  const owners = new Map<number, FuncSymbol>();
  const sorted = [...funcs].filter((f) => !f.synthetic).sort((a, b) => b.depth - a.depth);
  for (const f of sorted) {
    for (let line = f.startLine; line <= f.endLine; line++) {
      if (!owners.has(line)) owners.set(line, f);
    }
  }
  return owners;
}

/** 找出 def 名字 token 所在的行（供代码区把 ƒ 标记打在正确的行上）。 */
export function isDefLine(f: FuncSymbol, line: number): boolean {
  return f.nameRange.startLine === line;
}