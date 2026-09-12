/**
 * import 收集与"点号名 -> (模块 spec, 属性)"拆分。
 *
 * 支持形式：
 *   import x / import a.b.c / import a.b.c as y / import x, y
 *   from m import f / from m import f as g / from m import f, h
 *   from . import f / from .m import f / from ..pkg.m import f
 *   from m import *
 *
 * 注意：`from m import a, b` 的 name 字段是**可重复字段**，
 * childForFieldName 只返回第一个，必须用 fieldChildren（见 treeLike.ts）。
 */
import { fieldChildren, namedKids, startLineOf, walk, type SyntaxNodeLike } from './treeLike';

export interface ImportBindingBase {
  /** 书写形式里的模块名（相对 import 时为点号后面的部分，可能为 ''） */
  spec: string;
  /** 相对 import 的点号个数，绝对 import 为 0 */
  level: number;
  /** import 语句所在行（1-based） */
  line: number;
}

export interface ModuleImport extends ImportBindingBase {
  kind: 'module';
  /** 绑定到当前命名空间的名字：import a.b.c -> 'a'；import a.b as x -> 'x' */
  localName: string;
  /** 是否带 as 别名（决定后续点号是否要重新基于 spec 拼接） */
  aliased: boolean;
}

export interface FromImport extends ImportBindingBase {
  kind: 'from';
  localName: string;
  /** 源模块里的名字：from m import f as g -> attr='f', localName='g' */
  attr: string;
}

export interface WildcardImport extends ImportBindingBase {
  kind: 'wildcard';
}

export type ImportBinding = ModuleImport | FromImport | WildcardImport;

export interface ImportTable {
  byLocal: Map<string, ImportBinding>;
  wildcards: WildcardImport[];
  all: ImportBinding[];
}

function prefixDots(node: SyntaxNodeLike | null): number {
  if (!node) return 0;
  const m = /^\.+/.exec(node.text);
  return m ? m[0].length : 0;
}

function pushModuleImport(kid: SyntaxNodeLike, line: number, out: ImportBinding[]): void {
  if (kid.type === 'aliased_import') {
    const nm = kid.childForFieldName('name');
    const al = kid.childForFieldName('alias');
    if (!nm || !al) return;
    out.push({ kind: 'module', spec: nm.text, level: 0, line, localName: al.text, aliased: true });
    return;
  }
  if (kid.type === 'dotted_name' || kid.type === 'identifier') {
    const spec = kid.text;
    out.push({
      kind: 'module',
      spec,
      level: 0,
      line,
      localName: spec.split('.')[0] ?? spec,
      aliased: false,
    });
  }
}

function pushFromImportName(
  n: SyntaxNodeLike,
  spec: string,
  level: number,
  line: number,
  out: ImportBinding[],
): void {
  if (n.type === 'wildcard_import') {
    out.push({ kind: 'wildcard', spec, level, line });
    return;
  }
  if (n.type === 'aliased_import') {
    const nm = n.childForFieldName('name');
    const al = n.childForFieldName('alias');
    if (!nm || !al) return;
    out.push({ kind: 'from', spec, level, line, localName: al.text, attr: nm.text });
    return;
  }
  out.push({ kind: 'from', spec, level, line, localName: n.text, attr: n.text });
}

function collectImportStatement(node: SyntaxNodeLike, out: ImportBinding[]): void {
  const line = startLineOf(node);

  if (node.type === 'import_statement') {
    const fieldNames = fieldChildren(node, 'name');
    // 假树没有 childrenForFieldName 时，import 语句的具名子节点本来就全是 name
    for (const kid of fieldNames.length > 0 ? fieldNames : namedKids(node)) {
      pushModuleImport(kid, line, out);
    }
    return;
  }

  if (node.type === 'import_from_statement') {
    const kids = namedKids(node);
    let spec = '';
    let level = 0;
    // 语法保证 module_name 是第一个具名子节点（dotted_name 或 relative_import）
    const moduleNode = kids[0] ?? null;
    if (moduleNode) {
      if (moduleNode.type === 'relative_import') {
        for (const sub of namedKids(moduleNode)) {
          if (sub.type === 'import_prefix') level = prefixDots(sub);
          else if (sub.type === 'dotted_name') spec = sub.text;
        }
        if (level === 0) level = prefixDots(moduleNode);
      } else {
        spec = moduleNode.text;
      }
    }
    // `from m import *` 的 wildcard_import 不带 name 字段，此时走位置兜底
    const fieldNames = fieldChildren(node, 'name');
    const names = fieldNames.length > 0 ? fieldNames : kids.slice(moduleNode ? 1 : 0);
    for (const n of names) {
      pushFromImportName(n, spec, level, line, out);
    }
  }
}

/** 收集整个文件里的 import（含函数体内的 import）。 */
export function collectImports(root: SyntaxNodeLike): ImportBinding[] {
  const out: ImportBinding[] = [];
  walk(root, (n) => {
    if (n.type === 'import_statement' || n.type === 'import_from_statement') {
      collectImportStatement(n, out);
    }
  });
  return out;
}

export function buildImportTable(bindings: ImportBinding[]): ImportTable {
  const byLocal = new Map<string, ImportBinding>();
  const wildcards: WildcardImport[] = [];
  for (const b of bindings) {
    if (b.kind === 'wildcard') {
      wildcards.push(b);
      continue;
    }
    // 后写的 import 覆盖先写的（与 Python 运行时一致）
    byLocal.set(b.localName, b);
  }
  return { byLocal, wildcards, all: bindings };
}

export interface DottedTarget {
  /** 模块 spec（相对形式，需要再经 absoluteSpec + resolveModuleSpec）；'' 表示当前模块 */
  spec: string;
  /** 最终属性名；'' 表示这个名字本身就是模块 */
  attr: string;
  level: number;
  /** 名字来自 import 绑定还是隐式（未 import 的同包/同目录模块） */
  viaImport: boolean;
}

/**
 * 把 `a.b.c.f` 这样的点号名拆成 (模块 spec, 属性)。
 * 拆不出（例如 wildcard 绑定）时返回 null。
 */
export function splitDotted(dotted: string, table: ImportTable): DottedTarget | null {
  const parts = dotted.split('.').filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const head = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  const rest = parts.slice(1);
  const binding = table.byLocal.get(head);

  if (!binding) {
    // 没 import：可能是同包/同目录模块的隐式引用，交给后缀匹配去试
    return {
      spec: parts.length > 1 ? parts.slice(0, -1).join('.') : '',
      attr: last,
      level: 0,
      viaImport: false,
    };
  }

  if (binding.kind === 'wildcard') return null;

  if (binding.kind === 'module') {
    if (binding.aliased) {
      if (rest.length === 0) return { spec: binding.spec, attr: '', level: 0, viaImport: true };
      const mid = rest.slice(0, -1);
      return {
        spec: mid.length ? `${binding.spec}.${mid.join('.')}` : binding.spec,
        attr: rest[rest.length - 1] as string,
        level: 0,
        viaImport: true,
      };
    }
    if (rest.length === 0) return { spec: binding.spec, attr: '', level: 0, viaImport: true };
    // import a.b.c 后写 a.b.c.f()：书写路径本身就是绝对的
    return {
      spec: parts.slice(0, -1).join('.'),
      attr: last,
      level: 0,
      viaImport: true,
    };
  }

  // from m import f [as g]
  if (rest.length === 0) {
    return { spec: binding.spec, attr: binding.attr, level: binding.level, viaImport: true };
  }
  const base = binding.spec ? `${binding.spec}.${binding.attr}` : binding.attr;
  const mid = rest.slice(0, -1);
  return {
    spec: mid.length ? `${base}.${mid.join('.')}` : base,
    attr: rest[rest.length - 1] as string,
    level: binding.level,
    viaImport: true,
  };
}
