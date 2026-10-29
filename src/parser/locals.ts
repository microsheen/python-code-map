/**
 * 名字绑定收集（作用域分析的最小实现）。
 *
 * 目的只有一个：判断 `foo()` 里的 foo 是不是一个"当前作用域里的变量"。
 * 如果是变量（参数 / 赋值 / for 目标 / with as / except as / 局部 import），
 * 就无法静态确定它指向哪个函数 -> 归类为 dynamic，不连边。
 * 过度收集是安全的（只会少连边）。
 */
import { kids, namedKids, walk, type SyntaxNodeLike } from './treeLike';

const BINDING_FIELDS = ['left', 'name', 'variable', 'alias', 'pattern'];

/**
 * 这些节点只是"容器"，真正的绑定名在其具名子节点里：
 *   pattern_list  -> `a, b = ...` / `for a, b in ...`
 *   list_pattern  -> `with x as (a, b)` / `case [a, b]`
 *   as_pattern_target -> `as fh` 里的 fh
 */
const PATTERN_CONTAINERS = new Set([
  'pattern_list',
  'tuple',
  'list',
  'list_splat_pattern',
  'dictionary_splat_pattern',
  'tuple_pattern',
  'list_pattern',
  'dict_pattern',
  'union_pattern',
  'splat_pattern',
  'keyword_pattern',
  'as_pattern_target',
]);

function addFromNameNode(node: SyntaxNodeLike | null, out: Set<string>): void {
  if (!node) return;
  if (node.type === 'identifier') {
    out.add(node.text);
    return;
  }
  // `X as name`：只收 as 后面的绑定名，不收被打开的表达式 X
  if (node.type === 'as_pattern') {
    addFromNameNode(node.childForFieldName('alias'), out);
    return;
  }
  if (PATTERN_CONTAINERS.has(node.type)) {
    for (const k of namedKids(node)) addFromNameNode(k, out);
    return;
  }
  if (
    node.type === 'typed_parameter' ||
    node.type === 'default_parameter' ||
    node.type === 'typed_default_parameter'
  ) {
    addFromNameNode(node.childForFieldName('name'), out);
    return;
  }
}

/**
 * with / except 的目标：新版语法把 `open(p) as fh` 整体放在 value 字段里，
 * 旧版语法则直接把目标放在 alias / left / pattern 字段上。两种都收。
 */
function addFromTarget(node: SyntaxNodeLike, out: Set<string>): void {
  const t = node.type;
  if (t === 'as_pattern' || t === 'as_pattern_target') {
    addFromNameNode(node, out);
    return;
  }
  for (const f of ['alias', 'left', 'pattern', 'variable']) {
    const c = node.childForFieldName(f);
    if (c && (c.type === 'identifier' || PATTERN_CONTAINERS.has(c.type) || c.type === 'as_pattern')) {
      addFromNameNode(c, out);
    }
  }
}

/** 收集一个函数体内绑定的所有名字（含嵌套函数内部，宁多勿少）。 */
export function collectLocals(fnNode: SyntaxNodeLike): Set<string> {
  const out = new Set<string>();
  const params = fnNode.childForFieldName('parameters');
  if (params) {
    for (const p of namedKids(params)) addFromNameNode(p, out);
  }
  const body = fnNode.childForFieldName('body');
  if (!body) return out;
  walk(body, (n) => {
    switch (n.type) {
      case 'assignment':
      case 'augmented_assignment':
        addFromNameNode(n.childForFieldName('left'), out);
        break;
      case 'for_statement':
      case 'for_in_clause':
        addFromNameNode(n.childForFieldName('left'), out);
        addFromNameNode(n.childForFieldName('variable'), out);
        addFromNameNode(n.childForFieldName('pattern'), out);
        break;
      case 'with_item': {
        // 只有 `X as name` 才产生绑定；`with lock:` 里的 lock 是表达式，不是绑定
        const v = n.childForFieldName('value');
        if (v && (v.type === 'as_pattern' || v.type === 'as_pattern_target')) {
          addFromNameNode(v, out);
        }
        addFromTarget(n, out);
        break;
      }
      case 'function_definition':
      case 'class_definition':
        addFromNameNode(n.childForFieldName('name'), out);
        break;
      case 'import_statement':
      case 'import_from_statement':
        for (const kid of namedKids(n)) {
          if (kid.type === 'aliased_import') addFromNameNode(kid.childForFieldName('alias'), out);
          else if (kid.type === 'dotted_name' || kid.type === 'identifier') {
            const first = kid.text.split('.')[0];
            if (first) out.add(first);
          }
        }
        break;
      case 'lambda': {
        const lp = n.childForFieldName('parameters');
        if (lp) for (const p of namedKids(lp)) addFromNameNode(p, out);
        break;
      }
      case 'except_clause':
      case 'except_group_clause': {
        // except E as e: —— 新版语法 e 在 value 字段的 as_pattern 里；
        // 只有 as_pattern 才是绑定，`except ValueError:` 里的 ValueError 是表达式
        const ev = n.childForFieldName('value');
        if (ev && (ev.type === 'as_pattern' || ev.type === 'as_pattern_target')) {
          addFromNameNode(ev, out);
        }
        // 旧版语法兜底：直接扫 'as' token 后面的 identifier
        const ch = kids(n);
        for (let i = 0; i < ch.length - 1; i++) {
          if (ch[i]?.type === 'as') {
            const nxt = ch[i + 1];
            if (nxt && nxt.type === 'identifier') out.add(nxt.text);
          }
        }
        break;
      }
      default: {
        for (const f of BINDING_FIELDS) {
          if (f === 'left' || f === 'name') continue;
          addFromNameNode(n.childForFieldName(f), out);
        }
      }
    }
  });
  // global / nonlocal 声明的名字不算局部
  walk(body, (n) => {
    if (n.type === 'global_statement' || n.type === 'nonlocal_statement') {
      for (const kid of namedKids(n)) {
        if (kid.type === 'identifier') out.delete(kid.text);
      }
    }
  });
  return out;
}

/**
 * 模块级变量收集结果。
 */
export interface ModuleVarInfo {
  /** 纯变量名（不含 def/class 名字） */
  vars: Set<string>;
  /**
   * 模块级变量 -> 构造器类名（仅 VAR = ClassName(...) 形式）。
   * 用于解析 VAR.method() 这类调用：知道 VAR 是 ClassName 的实例，
   * 就可以把 VAR.method 解析为 ClassName.method。
   * 同一变量被多次赋值时从该 map 移除（类型不确定）。
   */
  types: Map<string, string>;
}

/**
 * 模块级作用域的名字。
 * 返回的 vars 只包含"纯变量"（不含 def/class 名字），
 * 因为 def 名字应该走函数解析而不是 dynamic。
 * 同时收集 VAR = ClassName(...) 形式的类型信息。
 */
export function collectModuleVars(root: SyntaxNodeLike): ModuleVarInfo {
  const out = new Set<string>();
  const types = new Map<string, string>();
  const defNames = new Set<string>();
  for (const n of namedKids(root)) {
    let target: SyntaxNodeLike = n;
    if (n.type === 'decorated_definition') {
      const d = n.childForFieldName('definition');
      if (!d) continue;
      target = d;
    }
    if (target.type === 'function_definition' || target.type === 'class_definition') {
      const nm = target.childForFieldName('name');
      if (nm) defNames.add(nm.text);
      continue;
    }
    if (n.type === 'expression_statement') {
      const inner = n.namedChildren[0];
      if (!inner) continue;
      if (inner.type === 'assignment' || inner.type === 'augmented_assignment') {
        const tmp = new Set<string>();
        addFromNameNode(inner.childForFieldName('left'), tmp);
        for (const t of tmp) {
          out.add(t);
          // 跟踪 VAR = ClassName(...) 的类型信息
          if (inner.type === 'assignment') {
            const rhs = inner.childForFieldName('right');
            if (rhs && rhs.type === 'call') {
              const fn = rhs.childForFieldName('function');
              if (fn && fn.type === 'identifier') {
                const className = fn.text;
                // 如果该变量已经被赋过值，类型不确定，移除
                if (types.has(t)) {
                  types.delete(t);
                } else {
                  types.set(t, className);
                }
              } else {
                // RHS 不是简单构造器调用，类型不确定
                types.delete(t);
              }
            } else {
              // RHS 不是 call，类型不确定
              types.delete(t);
            }
          } else {
            // augmented_assignment (+=, etc.) 类型不确定
            types.delete(t);
          }
        }
      }
      continue;
    }
    if (n.type === 'import_statement' || n.type === 'import_from_statement') {
      for (const kid of namedKids(n)) {
        if (kid.type === 'aliased_import') {
          const al = kid.childForFieldName('alias');
          if (al) out.add(al.text);
        } else if (kid.type === 'dotted_name' || kid.type === 'identifier') {
          const first = kid.text.split('.')[0];
          if (first) out.add(first);
        }
      }
    }
  }
  for (const d of defNames) out.delete(d);
  return { vars: out, types };
}


/**
 * 函数内局部变量类型推断（保守策略）。
 */
export function collectLocalTypes(fnNode: SyntaxNodeLike): Map<string, string> {
  const types = new Map<string, string>();
  const body = fnNode.childForFieldName('body');
  if (!body) return types;
  scanBlock(body, types);
  return types;
}

function scanBlock(block: SyntaxNodeLike, types: Map<string, string>): void {
  for (const n of namedKids(block)) {
    let target = n;
    if (n.type === 'decorated_definition') {
      const d = n.childForFieldName('definition');
      if (!d) continue;
      target = d;
    }
    if (target.type === 'function_definition' || target.type === 'class_definition') {
      continue;
    }
    if (n.type === 'expression_statement') {
      const inner = n.namedChildren[0];
      if (!inner) continue;
      if (inner.type === 'assignment') {
        const tmp = new Set<string>();
        addFromNameNode(inner.childForFieldName('left'), tmp);
        for (const t of tmp) {
          const rhs = inner.childForFieldName('right');
          if (rhs && rhs.type === 'call') {
            const fn = rhs.childForFieldName('function');
            if (fn && fn.type === 'identifier') {
              const className = fn.text;
              if (types.has(t)) {
                types.delete(t);
              } else {
                types.set(t, className);
              }
            } else {
              types.delete(t);
            }
          } else {
            types.delete(t);
          }
        }
      } else if (inner.type === 'augmented_assignment') {
        const tmp = new Set<string>();
        addFromNameNode(inner.childForFieldName('left'), tmp);
        for (const t of tmp) types.delete(t);
      }
    }
  }
}
