/**
 * 调用点解析 —— 保守策略：只连"唯一确定"的边，其余记 reason 不连。
 *
 * 解析顺序（简单名 foo()）：
 *   局部作用域 -> 文件级 def -> 文件级 class(构造 -> __init__) -> import 绑定
 *   -> 单一 wildcard import -> 内置名(external) -> 模块级变量(dynamic) -> unknown
 *
 * 点号名 a.b.f()：
 *   self/cls -> 所在类及其基类；前缀能解释成类 -> Class.method；否则当模块路径解析。
 */
import { isBuiltinName, isExternalModuleHead } from './builtins';
import { buildImportTable, collectImports, splitDotted, type ImportTable } from './imports';
import { collectLocals, collectLocalTypes, collectModuleVars } from './locals';
import { absoluteSpec, resolveModuleSpec, type ModuleIndex } from './modules';
import { makeFuncId, moduleId, type FileSymbols } from './symbols';
import { dottedText, isField, namedKids, type SyntaxNodeLike } from './treeLike';
import type { CallSite, ClassSymbol, FuncSymbol, UnresolvedReason } from './types';

export interface FileScope {
  path: string;
  funcs: FuncSymbol[];
  classes: ClassSymbol[];
  moduleFunc: FuncSymbol;
  /** 限定名 -> 函数 */
  byQualified: Map<string, FuncSymbol>;
  /** 模块级简单名 -> 函数（重定义时长度 > 1） */
  moduleLevelByName: Map<string, FuncSymbol[]>;
  /** 简单名 -> 模块内全部同名定义（含方法与嵌套函数），仅用于 ambiguous 判定 */
  anyByName: Map<string, FuncSymbol[]>;
  /** 限定名 -> 类 */
  classesByQName: Map<string, ClassSymbol>;
  importTable: ImportTable;
  moduleVars: Set<string>;
  /** 模块级变量 -> 构造器类名（VAR = ClassName(...)） */
  moduleVarTypes: Map<string, string>;
}

export interface ResolveContext {
  index: ModuleIndex;
  files: Map<string, FileScope>;
}

export function buildFileScope(
  path: string,
  syms: FileSymbols,
  root: SyntaxNodeLike,
): FileScope {
  const byQualified = new Map<string, FuncSymbol>();
  const moduleLevelByName = new Map<string, FuncSymbol[]>();
  const anyByName = new Map<string, FuncSymbol[]>();
  for (const f of syms.funcs) {
    byQualified.set(f.qualifiedName, f);
    const any = anyByName.get(f.name);
    if (any) any.push(f);
    else anyByName.set(f.name, [f]);
    if (f.depth === 0) {
      const arr = moduleLevelByName.get(f.name);
      if (arr) arr.push(f);
      else moduleLevelByName.set(f.name, [f]);
    }
  }
  const classesByQName = new Map<string, ClassSymbol>();
  for (const c of syms.classes) classesByQName.set(c.qualifiedName, c);
  return {
    path,
    funcs: syms.funcs,
    classes: syms.classes,
    moduleFunc: syms.moduleFunc,
    byQualified,
    moduleLevelByName,
    anyByName,
    classesByQName,
    importTable: buildImportTable(collectImports(root)),
    ...(() => { const mv = collectModuleVars(root); return { moduleVars: mv.vars, moduleVarTypes: mv.types }; })(),
  };
}

type Resolved = { target: string } | { reason: UnresolvedReason };

interface Frame {
  kind: 'module' | 'func' | 'class';
  name: string;
  /** 该作用域内定义的完整限定名前缀（module 帧为 ''） */
  qName: string;
  /** 调用点归属的函数 id */
  ownerId: string;
  locals: Set<string>;
  localTypes?: Map<string, string>;
}

const NO_LOCALS: Set<string> = new Set();
const SKIP_BASES = new Set(['object', 'ABC', 'Generic', 'Enum', 'Protocol', 'Exception']);

function oneLine(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function isLocalName(name: string, chain: Frame[]): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (!f) continue;
    if (f.kind === 'func' && f.locals.has(name)) return true;
    if (f.kind === 'module' && f.locals.has(name)) return true;
  }
  return false;
}

/**
 * 名字是否被函数作用域里的局部变量遮蔽。
 * import 绑定不算遮蔽——那种情况交给 import 表解析，能连出更准的跨文件边。
 */
function isShadowed(name: string, chain: Frame[], imports: ImportTable): boolean {
  if (imports.byLocal.has(name)) return false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (f && f.kind === 'func' && f.locals.has(name)) return true;
  }
  return false;
}
function constructorTarget(cls: ClassSymbol, fs: FileScope): Resolved {
  const init = fs.byQualified.get(`${cls.qualifiedName}.__init__`);
  if (init) return { target: init.id };
  return { reason: 'dynamic' };
}

/** 把类引用（可能是简单名 / 点号名 / import 进来的）解析到 (文件, 限定名)。 */
function resolveClassRef(
  ref: string,
  fs: FileScope,
  fromFile: string,
  ctx: ResolveContext,
): { fs: FileScope; q: string } | null {
  if (!ref || SKIP_BASES.has(ref)) return null;
  const local = fs.classesByQName.get(ref);
  if (local) return { fs, q: local.qualifiedName };
  const dt = splitDotted(ref, fs.importTable);
  if (!dt || !dt.attr) return null;
  const abs = absoluteSpec(dt.spec, dt.level, fromFile, ctx.index);
  const p = resolveModuleSpec(abs, ctx.index);
  if (!p) return null;
  const tfs = ctx.files.get(p);
  if (!tfs) return null;
  const c = tfs.classesByQName.get(dt.attr);
  return c ? { fs: tfs, q: c.qualifiedName } : null;
}

/** 在 target 文件里按 attr 找模块级函数 / 类构造。 */
function attrInFile(attr: string, tfs: FileScope): Resolved | null {
  const modLevel = tfs.moduleLevelByName.get(attr);
  if (modLevel && modLevel.length === 1 && modLevel[0]) return { target: modLevel[0].id };
  if (modLevel && modLevel.length > 1) return { reason: 'ambiguous' };
  const cls = tfs.classesByQName.get(attr);
  if (cls) return constructorTarget(cls, tfs);
  return null;
}

/** 按 (模块 spec, 属性) 解析；返回 null 表示"这条线索不适用，请继续尝试别的"。 */
function resolveViaModule(
  spec: string,
  attr: string,
  level: number,
  fromFile: string,
  ctx: ResolveContext,
): Resolved | null {
  const abs = absoluteSpec(spec, level, fromFile, ctx.index);
  const p = resolveModuleSpec(abs, ctx.index);
  if (!p) {
    const head = (abs || spec).split('.')[0] ?? '';
    if (head && isExternalModuleHead(head)) return { reason: 'external' };
    return null;
  }
  const tfs = ctx.files.get(p);
  if (!tfs) return null;
  if (!attr) return { reason: 'dynamic' }; // 调用的是一个模块对象
  const found = attrInFile(attr, tfs);
  if (found) return found;
  // attr 其实是个子模块（mod.sub()）-> 属性访问，不连边
  if (resolveModuleSpec(`${abs}.${attr}`, ctx.index)) return { reason: 'dynamic' };
  return null;
}

function resolveSimpleName(
  name: string,
  chain: Frame[],
  fs: FileScope,
  fromFile: string,
  ctx: ResolveContext,
): Resolved {
  // 1. 作用域链（由内向外）。class 作用域在 Python 里不对方法可见，跳过。
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (!f || f.kind !== 'func') continue;
    if (!f.locals.has(name)) continue;
    const q = f.qName ? `${f.qName}.${name}` : name;
    const nested = fs.byQualified.get(q);
    if (nested) return { target: nested.id };
    const nestedCls = fs.classesByQName.get(q);
    if (nestedCls) return constructorTarget(nestedCls, fs);
    return { reason: 'dynamic' }; // 局部变量遮蔽，无法静态确定
  }

  // 2. 文件级函数定义
  const modLevel = fs.moduleLevelByName.get(name);
  if (modLevel && modLevel.length === 1 && modLevel[0]) return { target: modLevel[0].id };
  if (modLevel && modLevel.length > 1) return { reason: 'ambiguous' };

  // 3. 文件级类 -> 构造
  const cls = fs.classesByQName.get(name);
  if (cls) return constructorTarget(cls, fs);

  // 4. import 绑定
  const dt = splitDotted(name, fs.importTable);
  if (dt) {
    const r = resolveViaModule(dt.spec, dt.attr, dt.level, fromFile, ctx);
    if (r) return r;
  }

  // 5. 唯一的 wildcard import
  if (fs.importTable.wildcards.length === 1) {
    const w = fs.importTable.wildcards[0];
    if (w) {
      const abs = absoluteSpec(w.spec, w.level, fromFile, ctx.index);
      const p = resolveModuleSpec(abs, ctx.index);
      const tfs = p ? ctx.files.get(p) : null;
      if (tfs) {
        const found = attrInFile(name, tfs);
        if (found) return found;
      }
    }
  }

  // 6. 内置名 / 标准库 / 第三方
  if (isBuiltinName(name)) return { reason: 'external' };

  // 7. 模块级变量
  if (fs.moduleVars.has(name)) return { reason: 'dynamic' };

  // 8. 模块内存在多个同名定义（例如两个类各有一个 run 方法）：宁可报"有歧义"，
  //    也不猜一个连出假边。放在最后，保证只把原本的 unknown 细分成 ambiguous，
  //    不影响前面任何一条已确定的解析路径。
  const sameName = fs.anyByName.get(name);
  if (sameName && sameName.length > 1) return { reason: 'ambiguous' };

  return { reason: 'unknown' };
}

function nearestClassFrame(chain: Frame[]): Frame | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (f && f.kind === 'class') return f;
  }
  return null;
}

/** self.foo() / cls.foo()：在所在类及其基类里找 foo。 */
function resolveSelfMethod(
  attr: string,
  chain: Frame[],
  fs: FileScope,
  fromFile: string,
  ctx: ResolveContext,
): Resolved {
  const clsFrame = nearestClassFrame(chain);
  if (!clsFrame) return { reason: 'unknown' };
  const seen = new Set<string>();
  const pending: { fs: FileScope; q: string }[] = [{ fs, q: clsFrame.qName }];
  let found: FuncSymbol | null = null;
  let hits = 0;
  let guard = 0;
  while (pending.length > 0 && guard++ < 64) {
    const cur = pending.shift();
    if (!cur) continue;
    const key = `${cur.fs.path}::${cur.q}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = cur.fs.byQualified.get(`${cur.q}.${attr}`);
    if (m) {
      found = m;
      hits++;
      continue;
    }
    const cls = cur.fs.classesByQName.get(cur.q);
    if (!cls) continue;
    for (const base of cls.bases) {
      const bn = base.split('=')[0]?.trim() ?? '';
      const ref = resolveClassRef(bn, cur.fs, fromFile, ctx);
      if (ref) pending.push(ref);
    }
  }
  if (hits === 1 && found) return { target: found.id };
  if (hits > 1) return { reason: 'ambiguous' };
  return { reason: 'unknown' };
}

/**
 * self.a.b.c.method() chain resolution.
 */
function resolveSelfChain(
  parts: string[],
  chain: Frame[],
  fs: FileScope,
  fromFile: string,
  ctx: ResolveContext,
): Resolved {
  const clsFrame = nearestClassFrame(chain);
  if (!clsFrame) return { reason: 'unknown' };

  function lookupAttr(
    attrName: string,
    curFs: FileScope,
    curQ: string,
  ): { fs: FileScope; q: string } | null {
    const seen = new Set<string>();
    const pending: { fs: FileScope; q: string }[] = [{ fs: curFs, q: curQ }];
    let guard = 0;
    while (pending.length > 0 && guard++ < 64) {
      const cur = pending.shift();
      if (!cur) continue;
      const key = `${cur.fs.path}::${cur.q}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = cur.fs.classesByQName.get(cur.q);
      if (!cls) continue;
      if (cls.instanceAttrs[attrName]) {
        const typeName = cls.instanceAttrs[attrName];
        const ref = resolveClassRef(typeName, cur.fs, fromFile, ctx);
        if (ref) return ref;
      }
      for (const base of cls.bases) {
        const bn = base.split('=')[0]?.trim() ?? '';
        const ref = resolveClassRef(bn, cur.fs, fromFile, ctx);
        if (ref) pending.push(ref);
      }
    }
    return null;
  }

  let curFs = fs;
  let curQ = clsFrame.qName;
  for (let i = 1; i < parts.length - 1; i++) {
    const next = lookupAttr(parts[i] as string, curFs, curQ);
    if (!next) return { reason: 'dynamic' };
    curFs = next.fs;
    curQ = next.q;
  }

  const methodName = parts[parts.length - 1] as string;
  const m = curFs.byQualified.get(`${curQ}.${methodName}`);
  if (m) return { target: m.id };
  return { reason: 'unknown' };
}
function resolveDottedName(
  dotted: string,
  chain: Frame[],
  fs: FileScope,
  fromFile: string,
  ctx: ResolveContext,
): Resolved {
  const parts = dotted.split('.').filter((s) => s.length > 0);
  if (parts.length === 0) return { reason: 'unknown' };
  const head = parts[0] as string;

  if (head === 'self' || head === 'cls') {
    if (parts.length === 2) {
      return resolveSelfMethod(parts[1] as string, chain, fs, fromFile, ctx);
    }
    return resolveSelfChain(parts, chain, fs, fromFile, ctx);
  }

  // 前缀能不能解释成一个类：Cls.method() / mod.Cls.method()
  for (let k = 1; k <= parts.length - 1; k++) {
    const prefix = parts.slice(0, k).join('.');
    const cref = resolveClassRef(prefix, fs, fromFile, ctx);
    if (!cref) continue;
    const rest = parts.slice(k);
    if (rest.length !== 1) return { reason: 'dynamic' };
    const m = cref.fs.byQualified.get(`${cref.q}.${rest[0]}`);
    if (m) return { target: m.id };
    return { reason: 'unknown' };
  }

  // 函数局部变量类型推断：VAR = ClassName(...) -> VAR.method 解析为 ClassName.method
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    if (f?.kind === 'func' && f.localTypes?.has(head)) {
      const clsName = f.localTypes.get(head) as string;
      const cref = resolveClassRef(clsName, fs, fromFile, ctx);
      if (cref) {
        const rest = parts.slice(1);
        if (rest.length === 1) {
          const m = cref.fs.byQualified.get(`${cref.q}.${rest[0]}`);
          if (m) return { target: m.id };
        }
      }
    }
  }
  // 函数作用域里的局部变量遮蔽（utils = ...）：无法静态确定
  if (isShadowed(head, chain, fs.importTable)) return { reason: 'dynamic' };

  // 模块级变量类型推断：VAR = ClassName(...) -> VAR.method 解析为 ClassName.method
  // 必须在 isLocalName 之前检查，因为 moduleVars 会被用作 module frame 的 locals，
  // isLocalName 会把模块级变量当作“局部变量”返回 true。
  if (fs.moduleVarTypes.has(head)) {
    const clsName = fs.moduleVarTypes.get(head) as string;
    const cref = resolveClassRef(clsName, fs, fromFile, ctx);
    if (cref) {
      const rest = parts.slice(1);
      if (rest.length === 1) {
        const m = cref.fs.byQualified.get(`${cref.q}.${rest[0]}`);
        if (m) return { target: m.id };
      }
    }
  }

  const dt = splitDotted(dotted, fs.importTable);
  // import 绑定必须先于"模块级变量接收者"判定：collectModuleVars 会把 import 进来的
  // 名字也算作模块级名字，若先判变量，utils.calc() 这种最常见的跨文件调用会被误判成 dynamic。
  if (dt && dt.viaImport) {
    const r = resolveViaModule(dt.spec, dt.attr, dt.level, fromFile, ctx);
    if (r) return r;
  }

  // 普通变量接收者：obj.method()
  if (isLocalName(head, chain)) return { reason: 'dynamic' };

  if (dt) {
    const r = resolveViaModule(dt.spec, dt.attr, dt.level, fromFile, ctx);
    if (r) return r;
  }
  const headSpec = (dt?.spec || dotted).split('.')[0] ?? '';
  if (headSpec && isExternalModuleHead(headSpec)) return { reason: 'external' };
  if (fs.moduleVars.has(head)) return { reason: 'dynamic' };
  return { reason: 'unknown' };
}

/** 收集一个文件里的全部调用点（含模块级调用，归属到 <module> 伪函数）。 */
export function collectCalls(
  path: string,
  root: SyntaxNodeLike,
  ctx: ResolveContext,
): CallSite[] {
  const fs = ctx.files.get(path);
  if (!fs) return [];
  const out: CallSite[] = [];
  const moduleFrame: Frame = {
    kind: 'module',
    name: '',
    qName: '',
    ownerId: moduleId(path),
    locals: fs.moduleVars,
  };

  const record = (callNode: SyntaxNodeLike, chain: Frame[]): void => {
    const fn = callNode.childForFieldName('function');
    if (!fn) return;
    const owner = chain[chain.length - 1]?.ownerId ?? moduleId(path);
    let res: Resolved;
    if (fn.type === 'identifier') {
      res = resolveSimpleName(fn.text, chain, fs, path, ctx);
    } else if (fn.type === 'attribute') {
      const d = dottedText(fn);
      res = d ? resolveDottedName(d, chain, fs, path, ctx) : { reason: 'dynamic' };
    } else {
      res = { reason: 'dynamic' };
    }
    const target = 'target' in res ? res.target : null;
    out.push({
      file: path,
      line: fn.startPosition.row + 1,
      column: fn.startPosition.column,
      text: oneLine(fn.text),
      caller: owner,
      target,
      reason: target ? 'resolved' : 'reason' in res ? res.reason : 'unknown',
    });
  };

  const visit = (node: SyntaxNodeLike, chain: Frame[]): void => {
    for (const kid of namedKids(node)) {
      if (kid.type === 'decorated_definition') {
        for (const sub of namedKids(kid)) {
          if (sub.type === 'decorator') visit(sub, chain);
          else if (isField(kid, 'definition', sub)) visitDef(sub, chain);
        }
        continue;
      }
      if (kid.type === 'function_definition' || kid.type === 'class_definition') {
        visitDef(kid, chain);
        continue;
      }
      if (kid.type === 'call') {
        record(kid, chain);
        visit(kid, chain);
        continue;
      }
      visit(kid, chain);
    }
  };

  const visitDef = (node: SyntaxNodeLike, chain: Frame[]): void => {
    const parent = chain[chain.length - 1];
    const nameNode = node.childForFieldName('name');
    const name = nameNode?.text ?? '<anonymous>';
    const qName = parent && parent.qName ? `${parent.qName}.${name}` : name;
    const body = node.childForFieldName('body');
    if (!body) return;
    if (node.type === 'class_definition') {
      const frame: Frame = {
        kind: 'class',
        name,
        qName,
        ownerId: parent?.ownerId ?? moduleId(path),
        locals: NO_LOCALS,
      };
      visit(body, [...chain, frame]);
      return;
    }
    const frame: Frame = {
      kind: 'func',
      name,
      qName,
      ownerId: makeFuncId(path, qName),
      locals: collectLocals(node),
      localTypes: collectLocalTypes(node),
    };
    visit(body, [...chain, frame]);
  };

  visit(root, [moduleFrame]);
  return out;
}
