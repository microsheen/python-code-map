/**
 * 模块索引：把上传的文件路径集合映射成 Python 模块名空间。
 *
 * 规则：
 * - 以所有上传路径的最长公共目录前缀为包根（若根目录本身是包，即存在 __init__.py，则再上退一层）
 * - a/b/c.py        -> a.b.c
 * - a/b/__init__.py -> a.b
 * - 精确匹配失败时做后缀匹配（用户上传零散文件、没有完整包结构时仍能连上）
 * - 多个候选 -> 视为歧义，返回 null（保守策略：宁可不连边，也不连错）
 */

export interface ModuleIndex {
  /** 包根目录（'' 表示以上传路径本身为根） */
  root: string;
  /** 归一化后的文件路径 */
  paths: string[];
  /** path -> dotted 模块名 */
  moduleName: Map<string, string>;
  /** dotted 模块名 -> path */
  byModule: Map<string, string>;
  /** 模块名最后一段 -> paths（兜底模糊匹配用） */
  byLastSegment: Map<string, string[]>;
}

export function normalizePath(p: string): string {
  let s = (p || '').replace(/\\/g, '/').trim();
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  return s;
}

function dirSegments(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  return parts.filter((s) => s.length > 0);
}

/** 所有文件目录部分的最长公共前缀；再按 __init__.py 上退。 */
export function computePackageRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  const dirs = paths.map((p) => dirSegments(normalizePath(p)));
  let prefix: string[] = dirs[0] ? [...dirs[0]] : [];
  for (let i = 1; i < dirs.length; i++) {
    const d = dirs[i] ?? [];
    let j = 0;
    while (j < prefix.length && j < d.length && prefix[j] === d[j]) j++;
    prefix = prefix.slice(0, j);
  }
  // 根目录本身是个包（存在 root/__init__.py）时上退一层，保证包名保留在模块名里
  const set = new Set(paths.map((p) => normalizePath(p)));
  while (prefix.length > 0) {
    const candidate = prefix.join('/') + '/__init__.py';
    if (set.has(candidate)) prefix = prefix.slice(0, -1);
    else break;
  }
  return prefix.join('/');
}

export function moduleNameOf(path: string, root: string): string {
  const p = normalizePath(path);
  const r = normalizePath(root);
  let rel = r && (p === r || p.startsWith(r + '/')) ? p.slice(r.length + 1) : p;
  rel = rel.replace(/\.(py|pyi)$/i, '');
  if (rel === '__init__') return '';
  if (rel.endsWith('/__init__')) rel = rel.slice(0, -'/__init__'.length);
  return rel.split('/').filter(Boolean).join('.');
}

export function buildModuleIndex(paths: string[]): ModuleIndex {
  const norm = paths.map(normalizePath).filter((p) => p.length > 0);
  const root = computePackageRoot(norm);
  const moduleName = new Map<string, string>();
  const byModule = new Map<string, string>();
  const byLastSegment = new Map<string, string[]>();
  for (const p of norm) {
    let m = moduleNameOf(p, root);
    if (!m) {
      // 极端情况：根就是包本身且没有上层名字，用文件名兜底
      const base = p.split('/').pop() ?? p;
      m = base.replace(/\.(py|pyi)$/i, '').replace(/^__init__$/, 'root');
    }
    moduleName.set(p, m);
    if (!byModule.has(m)) byModule.set(m, p);
    const last = m.split('.').pop() ?? m;
    const arr = byLastSegment.get(last);
    if (arr) arr.push(p);
    else byLastSegment.set(last, [p]);
  }
  return { root, paths: norm, moduleName, byModule, byLastSegment };
}

/**
 * 把一个 import 里写的模块名解析成上传文件路径。
 * 返回 null 表示"解析不出唯一目标"（可能是外部模块，也可能歧义）。
 */
export function resolveModuleSpec(spec: string, index: ModuleIndex): string | null {
  if (!spec) return null;
  const s = spec.trim();
  if (!s) return null;
  const exact = index.byModule.get(s);
  if (exact) return exact;

  const cands = new Set<string>();
  for (const [m, p] of index.byModule) {
    if (m === s || m.endsWith('.' + s) || s.endsWith('.' + m)) cands.add(p);
  }
  if (cands.size === 1) return [...cands][0] ?? null;
  if (cands.size > 1) return null; // 歧义，不猜

  const last = s.split('.').pop() ?? s;
  const fuzzy = index.byLastSegment.get(last);
  if (fuzzy && fuzzy.length === 1) return fuzzy[0] ?? null;
  return null;
}

/** 某个 spec 是否指向 index 里的一个子模块（用于 `from pkg import submod`）。 */
export function resolveSubmodule(parentSpec: string, name: string, index: ModuleIndex): string | null {
  const spec = parentSpec ? `${parentSpec}.${name}` : name;
  return resolveModuleSpec(spec, index);
}

/**
 * 把相对 import 的 spec 变成绝对 spec。
 * level: 点的个数（from . -> 1, from .. -> 2）；spec 可能为 ''（from . import x）
 */
export function absoluteSpec(
  spec: string,
  level: number,
  fromFile: string,
  index: ModuleIndex,
): string {
  if (level <= 0) return spec;
  const self = index.moduleName.get(normalizePath(fromFile)) ?? moduleNameOf(fromFile, index.root);
  const isInit = /(^|\/)__init__\.pyi?$/.test(normalizePath(fromFile));
  let parts = self ? self.split('.') : [];
  if (!isInit && parts.length > 0) parts = parts.slice(0, -1);
  for (let i = 1; i < level && parts.length > 0; i++) parts = parts.slice(0, -1);
  const base = parts.join('.');
  if (!base) return spec;
  return spec ? `${base}.${spec}` : base;
}

/** 文件所属包（绝对 spec 形式），用于相对 import 与同包推断。 */
export function packageOf(file: string, index: ModuleIndex): string {
  const p = normalizePath(file);
  const self = index.moduleName.get(p) ?? moduleNameOf(p, index.root);
  const isInit = /(^|\/)__init__\.pyi?$/.test(p);
  let parts = self ? self.split('.') : [];
  if (!isInit && parts.length > 0) parts = parts.slice(0, -1);
  return parts.join('.');
}