/**
 * github.com 页面 URL 的识别与推导（issue #5 · ADR-0006 决策 1）。
 *
 * 这一版只做三件事：
 * 1. 把三类页面 URL 认出来（仓库根 / tree 目录 / blob 单文件）；
 * 2. 把「ref + 仓库内路径」拆开，并给出请求 URL（GitHub REST 的 trees、raw 内容）；
 * 3. 把 trees 的清单解析成勾选清单需要的条目（路径、体积、是否可勾）。
 *
 * 纯函数：不发请求、不读时钟、不碰 DOM。网络编排在 githubFetch.ts，store 只消费它的结果。
 *
 * ref 里有斜杠（feature/x）时，光看 URL 分不清「ref=feature + 目录 x/...」还是
 * 「ref=feature/x + 目录 ...」。GitHub 自己也面对同一个歧义，所以这里不猜单一答案：
 * githubLocations() 按「最短 ref 优先」列出所有可能拆分，编排层逐个试到第一个成功为止。
 * 正常分支（main）第一次就成功，只有带斜杠的分支才多试一次 —— 常见路径仍然是一次请求。
 */

import { MAX_FILE_SIZE } from '../parser/analyze';
import { isPythonPath, wireUrl } from './paths';

export const GITHUB_HOST = 'github.com';
export const GITHUB_API_HOST = 'api.github.com';
export const GITHUB_RAW_HOST = 'raw.githubusercontent.com';

export type GithubKind = 'repo' | 'tree' | 'blob';

export interface GithubTarget {
  kind: GithubKind;
  owner: string;
  repo: string;
  /** `/tree/` 或 `/blob/` 之后的全部路径段（已解码）；仓库根形态是空数组 */
  rest: string[];
  /** 用户输入归一化后的 URL（不含 hash），批次身份与来源都用它 */
  url: string;
}

export type GithubTargetResult =
  | { kind: 'github'; target: GithubTarget }
  /** 主机不是 github.com，或者不是仓库/目录/文件页面 —— 交给直链分流继续判 */
  | { kind: 'not-github' }
  /** 是 github.com 的 blob 页面，但指向的不是 Python 文件 */
  | { kind: 'not-python' };

function pathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** 识别一条 URL 是不是 github.com 的仓库/目录/文件页面。 */
export function githubTargetOf(u: URL): GithubTargetResult {
  if (u.hostname.toLowerCase() !== GITHUB_HOST) return { kind: 'not-github' };
  const segs = pathSegments(u.pathname);
  if (!segs) return { kind: 'not-github' };
  const [owner, repo, mode, ...rest] = segs;
  if (!owner || !repo) return { kind: 'not-github' };
  if (!mode) {
    return {
      kind: 'github',
      target: { kind: 'repo', owner, repo, rest: [], url: wireUrl(u) },
    };
  }
  if (mode === 'tree' && rest.length > 0) {
    return {
      kind: 'github',
      target: { kind: 'tree', owner, repo, rest, url: wireUrl(u) },
    };
  }
  if (mode === 'blob' && rest.length > 1) {
    if (!isPythonPath(rest[rest.length - 1] ?? '')) return { kind: 'not-python' };
    return {
      kind: 'github',
      target: { kind: 'blob', owner, repo, rest, url: wireUrl(u) },
    };
  }
  return { kind: 'not-github' };
}

/** 一种「ref + 路径」的拆分。tree 的 path 是目录（可为空），blob 的 path 是文件。 */
export interface GithubLocation {
  ref: string;
  path: string;
}

/**
 * 按「最短 ref 优先」列出所有可能拆分。
 *
 * - 单段：`/tree/main` -> ref=main、目录为空；
 * - `main/src/pkg` -> `main` + `src/pkg`，再 `main/src` + `pkg`，最后 `main/src/pkg` + 空；
 * - blob 同理，但最后一段必须留给文件路径（path 永不为空）。
 *
 * 顺序是刻意的：正常分支第一次就命中，带斜杠的分支（feature/x）第二次才命中，
 * 常见路径不会为歧义多付一次请求。
 */
export function githubLocations(target: GithubTarget): GithubLocation[] {
  if (target.kind === 'repo') return [];
  const rest = target.rest;
  const max = target.kind === 'blob' ? rest.length - 1 : rest.length;
  const out: GithubLocation[] = [];
  for (let i = 1; i <= max; i += 1) {
    out.push({ ref: rest.slice(0, i).join('/'), path: rest.slice(i).join('/') });
  }
  return out;
}

function encodeSeg(s: string): string {
  return encodeURIComponent(s);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeSeg)
    .join('/');
}

function encodeRef(ref: string): string {
  return encodePath(ref);
}

/** 仓库元数据：只需要 default_branch（裸仓库 URL 用它取默认分支）。 */
export function githubRepoMetaUrl(owner: string, repo: string): string {
  return `https://${GITHUB_API_HOST}/repos/${encodeSeg(owner)}/${encodeSeg(repo)}`;
}

/**
 * 分支前缀查询：一次请求就能拿到「所有以该前缀开头的 head」。
 *
 * 只用于 blob URL 的 ref 拆分（raw 请求本身不关心拆分，但会话身份需要知道
 * ref 到哪里结束）。前缀只取首段，所以不会太宽；html_url 之外不带任何鉴权。
 */
export function githubMatchingRefsUrl(owner: string, repo: string, prefix: string): string {
  return `https://${GITHUB_API_HOST}/repos/${encodeSeg(owner)}/${encodeSeg(
    repo
  )}/git/matching-refs/heads/${encodeSeg(prefix)}`;
}

/** matching-refs 的 JSON -> 分支名（去掉 refs/heads/ 前缀）。 */
export function parseGithubRefs(text: string): GithubParseResult<string[]> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: GITHUB_BAD_RESPONSE };
  }
  if (!Array.isArray(json)) return { ok: false, message: GITHUB_BAD_RESPONSE };
  const refs: string[] = [];
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue;
    const ref = (item as Record<string, unknown>)['ref'];
    if (typeof ref !== 'string') continue;
    const marker = 'refs/heads/';
    if (ref.startsWith(marker) && ref.length > marker.length) refs.push(ref.slice(marker.length));
  }
  return { ok: true, value: refs };
}

/** 从候选分支里挑出最长、且正好是 rest 前缀的那个。 */
export function longestRefPrefix(refs: readonly string[], rest: readonly string[]): string | null {
  let best: string | null = null;
  for (const ref of refs) {
    const parts = ref.split('/');
    if (parts.length > rest.length) continue;
    if (!parts.every((p, i) => p === rest[i])) continue;
    if (!best || parts.length > best.split('/').length) best = ref;
  }
  return best;
}

/** 一次递归 trees 请求：清单含每项 size，不逐目录翻页。 */
export function githubTreeUrl(owner: string, repo: string, ref: string): string {
  return `https://${GITHUB_API_HOST}/repos/${encodeSeg(owner)}/${encodeSeg(
    repo
  )}/git/trees/${encodeRef(ref)}?recursive=1`;
}

/** raw 内容请求：ref 里保留斜杠（GitHub 会按 git ref 解析），路径逐段编码。 */
export function githubRawUrl(owner: string, repo: string, ref: string, path: string): string {
  const tail = encodePath(path);
  return `https://${GITHUB_RAW_HOST}/${encodeSeg(owner)}/${encodeSeg(repo)}/${encodeRef(
    ref
  )}${tail ? '/' + tail : ''}`;
}

/**
 * 拉取文件在会话里的路径身份：owner/repo/ + 仓库相对路径。
 *
 * 为什么不是 host + 页面路径：同一仓库的多文件要能自动连边，模块根必须落在
 * owner/repo 这一层（parser/modules.ts 的最长公共目录规则），页面路径里的 blob/<ref>
 * 会把这个根切碎。带上 owner/repo 同时也满足「不同仓库的同名文件不互相覆盖」。
 */
export function githubSessionPath(owner: string, repo: string, path: string): string {
  return [owner, repo, path].filter((s) => s.length > 0).join('/');
}

export type GithubParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const GITHUB_BAD_RESPONSE =
  'GitHub returned an unexpected response — the repository may be private, or the link may be wrong';

export const GITHUB_TRUNCATED_MESSAGE =
  'GitHub truncated the repository listing — this repository is too large for one request. Paste a directory URL (…/tree/<ref>/<dir>) to list a smaller part.';

export const GITHUB_PATH_MISSING =
  'GitHub has no files at that path — check the branch and directory in the URL';

/** 仓库元数据 JSON -> 默认分支。 */
export function parseRepoDefaultBranch(text: string): GithubParseResult<string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: GITHUB_BAD_RESPONSE };
  }
  const branch =
    typeof json === 'object' && json !== null
      ? (json as Record<string, unknown>)['default_branch']
      : undefined;
  if (typeof branch !== 'string' || branch.length === 0) {
    return { ok: false, message: GITHUB_BAD_RESPONSE };
  }
  return { ok: true, value: branch };
}

export interface GithubTreeEntry {
  /** 仓库相对路径（保留完整前缀，会话路径还要再加 owner/repo/） */
  path: string;
  /** JSON 里的 size；缺失时按 0（symlink/submodule 不是 blob，已被过滤） */
  size: number;
}

export interface GithubTree {
  truncated: boolean;
  /** 只要 .py/.pyi 的 blob；目录树本身不混进来 */
  entries: GithubTreeEntry[];
  /** 递归清单里的全部目录路径：用来判断用户给的那个目录到底存不存在 */
  dirs: string[];
}

/** trees?recursive=1 的 JSON -> 清单。 */
export function parseGithubTree(text: string): GithubParseResult<GithubTree> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: GITHUB_BAD_RESPONSE };
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, message: GITHUB_BAD_RESPONSE };
  }
  const raw = (json as Record<string, unknown>)['tree'];
  if (!Array.isArray(raw)) return { ok: false, message: GITHUB_BAD_RESPONSE };

  const entries: GithubTreeEntry[] = [];
  const dirs: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const node = item as Record<string, unknown>;
    const path = node['path'];
    if (typeof path !== 'string' || path.length === 0) continue;
    const type = node['type'];
    if (type === 'tree') {
      dirs.push(path);
      continue;
    }
    if (type !== 'blob' || !isPythonPath(path)) continue;
    const size = node['size'];
    entries.push({
      path,
      size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    });
  }
  return {
    ok: true,
    value: { truncated: (json as Record<string, unknown>)['truncated'] === true, entries, dirs },
  };
}

/** 目录在递归清单里存在吗（根目录永远存在）。 */
export function githubDirExists(tree: GithubTree, dir: string): boolean {
  if (!dir) return true;
  return tree.dirs.some((d) => d === dir || d.startsWith(dir + '/'));
}

/** 只留该目录下的文件；路径保留仓库相对形态（会话路径 = owner/repo/ + 它）。 */
export function githubEntriesInDir(tree: GithubTree, dir: string): GithubTreeEntry[] {
  if (!dir) return tree.entries;
  const prefix = dir.replace(/\/+$/, '') + '/';
  return tree.entries.filter((e) => e.path.startsWith(prefix));
}

/**
 * 清单条目 -> 勾选条目（#6 的输入）。
 *
 * selectable 只按 1MB 上限判：剩余配额与已选集合是 #6 的交互状态，不该塞进解析层。
 */
export interface GithubPickEntry {
  /** 仓库相对路径 */
  path: string;
  /** 会话里的身份：owner/repo/ + path */
  sessionPath: string;
  size: number;
  selectable: boolean;
}

export function githubPickEntries(
  owner: string,
  repo: string,
  entries: GithubTreeEntry[]
): GithubPickEntry[] {
  return entries.map((e) => ({
    path: e.path,
    sessionPath: githubSessionPath(owner, repo, e.path),
    size: e.size,
    selectable: e.size <= MAX_FILE_SIZE,
  }));
}

/** 一次导入解析出的清单（#6 的勾选界面直接消费）。 */
export interface GithubListing {
  sourceUrl: string;
  owner: string;
  repo: string;
  ref: string;
  /** 用户 URL 里的目录（根为 ''） */
  dir: string;
  entries: GithubPickEntry[];
}
