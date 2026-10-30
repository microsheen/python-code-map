/**
 * github 分流的网络编排（issue #5）：把 github.ts 的纯推导变成一组 GET。
 *
 * 这里只依赖 PullTransport 接口，所以 store 单测可以注入假传输；真 fetch 仍然只在
 * platform/web/pullFetch.ts 那一处。所有请求都是 GET、无请求体 —— 推导出的 URL 是唯一输入。
 *
 * 失败分类沿用 errors.ts：api.github.com 的 401/403/404 会被翻译成「不支持私有仓库」，
 * 限速（403 + 限速头）仍然走「稍后再试」那一句。
 */
import { classifyFailure } from './errors';
import type { PullOutcome, PullTransport } from './transport';
import { PULL_TIMEOUT_MS } from './urls';
import {
  GITHUB_BAD_RESPONSE,
  GITHUB_PATH_MISSING,
  GITHUB_TRUNCATED_MESSAGE,
  githubDirExists,
  githubEntriesInDir,
  githubLocations,
  githubMatchingRefsUrl,
  githubPickEntries,
  githubRawUrl,
  githubRepoMetaUrl,
  githubTreeUrl,
  longestRefPrefix,
  parseGithubRefs,
  parseGithubTree,
  parseRepoDefaultBranch,
  type GithubListing,
  type GithubLocation,
  type GithubTarget,
} from './github';

export type GithubFileResult =
  | { ok: true; ref: string; path: string; text: string }
  | { ok: false; message: string };

export type GithubListingResult =
  | { ok: true; listing: GithubListing }
  | { ok: false; message: string };

function crash(e: unknown): PullOutcome {
  return {
    ok: false,
    observation: { type: 'crash', detail: e instanceof Error ? e.message : String(e) },
  };
}

/** 传输外壳自己 reject 不该把整轮拉取带走：和 store 里直链那条路径一样按单文件失败处理。 */
async function get(transport: PullTransport, url: string): Promise<PullOutcome> {
  try {
    return await transport.get({ url, timeoutMs: PULL_TIMEOUT_MS });
  } catch (e) {
    return crash(e);
  }
}

function is404(outcome: PullOutcome): boolean {
  return !outcome.ok && outcome.observation.type === 'status' && outcome.observation.status === 404;
}

/** api.github.com 的 401/403/404 都归「私有仓库不支持」：拿不到内容时的统一解释。 */
function isApiAuthFailure(outcome: PullOutcome): boolean {
  if (outcome.ok || outcome.observation.type !== 'status') return false;
  const s = outcome.observation.status;
  return s === 401 || s === 403 || s === 404;
}

/**
 * 一次拉取内的 ref 解析缓存。
 *
 * raw 请求本身不关心 ref 在哪里结束（把 ref+path 连起来发就行），但会话身份需要拆分。
 * 带斜杠的分支只能靠 matching-refs 解析；把结果按「仓库 + 首段」缓存，一次粘贴里的
 * 多文件就不会为同一个仓库反复查分支（匿名限速 60/h 很薄）。
 */
export interface GithubFetchCache {
  refs: Map<string, string[] | null>;
}

export function createGithubFetchCache(): GithubFetchCache {
  return { refs: new Map() };
}

const FULL_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * 拆分 blob URL 的 ref 与文件路径：最短 ref 优先，用 matching-refs 找最长前缀。
 *
 * matching-refs 失败（网络/限速/私有）不阻断单文件拉取：退回「首段 = ref」这个最常见的
 * 形态，raw 请求仍按原样发出 —— 解析只是为了让身份正确，不该把文件本身也拖下水。
 */
async function resolveBlobLocation(
  target: GithubTarget,
  transport: PullTransport,
  cache: GithubFetchCache
): Promise<GithubLocation | null> {
  const rest = target.rest;
  const first = rest[0];
  if (!first) return null;
  if (FULL_SHA_RE.test(first)) return { ref: first, path: rest.slice(1).join('/') };

  const key = `${target.owner}/${target.repo}#${first}`;
  let refs = cache.refs.get(key);
  if (refs === undefined) {
    const url = githubMatchingRefsUrl(target.owner, target.repo, first);
    const outcome = await get(transport, url);
    const parsed = outcome.ok ? parseGithubRefs(outcome.text) : null;
    refs = parsed?.ok ? parsed.value : null;
    cache.refs.set(key, refs);
  }

  const matched = refs ? longestRefPrefix(refs, rest) : null;
  if (matched) {
    return { ref: matched, path: rest.slice(matched.split('/').length).join('/') };
  }
  return { ref: first, path: rest.slice(1).join('/') };
}

/**
 * 单文件（blob URL）：跳过清单，先解析 ref（只为身份），再发一次 raw 请求。
 *
 * raw 404 时再问一次仓库元数据，只为把「私有/不存在」（元数据也 404）与
 * 「文件路径不对」（元数据 200）分开 —— 这一次请求只发生在失败路径上。
 */
export async function fetchGithubFile(
  target: GithubTarget,
  transport: PullTransport,
  cache: GithubFetchCache = createGithubFetchCache()
): Promise<GithubFileResult> {
  const loc = await resolveBlobLocation(target, transport, cache);
  if (!loc) return { ok: false, message: GITHUB_BAD_RESPONSE };

  const url = githubRawUrl(target.owner, target.repo, loc.ref, loc.path);
  const outcome = await get(transport, url);
  if (outcome.ok) return { ok: true, ref: loc.ref, path: loc.path, text: outcome.text };
  if (!is404(outcome)) {
    return { ok: false, message: classifyFailure(outcome.observation, url).message };
  }

  const repoUrl = githubRepoMetaUrl(target.owner, target.repo);
  const meta = await get(transport, repoUrl);
  if (!meta.ok && isApiAuthFailure(meta)) {
    return { ok: false, message: classifyFailure(meta.observation, repoUrl).message };
  }
  return { ok: false, message: classifyFailure(outcome.observation, url).message };
}

/** 裸仓库 URL：多发一次仓库元数据请求，只为取默认分支。 */
async function repoDefaultBranch(
  target: GithubTarget,
  transport: PullTransport
): Promise<{ ok: true; ref: string } | { ok: false; message: string }> {
  const url = githubRepoMetaUrl(target.owner, target.repo);
  const outcome = await get(transport, url);
  if (!outcome.ok) {
    return { ok: false, message: classifyFailure(outcome.observation, url).message };
  }
  const parsed = parseRepoDefaultBranch(outcome.text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, ref: parsed.value };
}

/**
 * 仓库/目录 URL：一次 trees 递归请求出清单。
 *
 * 目录候选逐个试（见 githubLocations 的斜杠说明），每个候选最多一次 trees 请求。
 * truncated 是「这一份清单不完整」的显式失败：不拿 contents API 兜底翻页，也不发更多请求，
 * 直接把建议换成目录级 URL 的那句话交给用户。唯一的例外是斜杠分支的中间候选 —— 后面的候选
 * 是**另一个 ref**，它的树可能完整，所以那里继续试；所有候选都不成时仍然报 truncated。
 */
export async function fetchGithubListing(
  target: GithubTarget,
  transport: PullTransport
): Promise<GithubListingResult> {
  let locations: GithubLocation[];
  if (target.kind === 'repo') {
    const branch = await repoDefaultBranch(target, transport);
    if (!branch.ok) return branch;
    locations = [{ ref: branch.ref, path: '' }];
  } else {
    locations = githubLocations(target);
  }

  let sawTree = false;
  let sawTruncated = false;
  let last: { outcome: PullOutcome; url: string } | null = null;
  for (let i = 0; i < locations.length; i += 1) {
    const loc = locations[i] as GithubLocation;
    const url = githubTreeUrl(target.owner, target.repo, loc.ref);
    const outcome = await get(transport, url);
    if (!outcome.ok) {
      last = { outcome, url };
      if (is404(outcome)) continue;
      return { ok: false, message: classifyFailure(outcome.observation, url).message };
    }

    const parsed = parseGithubTree(outcome.text);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    sawTree = true;
    const isLast = i === locations.length - 1;
    if (parsed.value.truncated) {
      sawTruncated = true;
      if (!isLast) continue;
      return { ok: false, message: GITHUB_TRUNCATED_MESSAGE };
    }

    if (!githubDirExists(parsed.value, loc.path) && !isLast) continue;

    const entries = githubEntriesInDir(parsed.value, loc.path);
    return {
      ok: true,
      listing: {
        sourceUrl: target.url,
        owner: target.owner,
        repo: target.repo,
        ref: loc.ref,
        dir: loc.path,
        entries: githubPickEntries(target.owner, target.repo, entries),
      },
    };
  }

  if (sawTruncated) return { ok: false, message: GITHUB_TRUNCATED_MESSAGE };
  if (sawTree) return { ok: false, message: GITHUB_PATH_MISSING };
  if (last && !last.outcome.ok) {
    return { ok: false, message: classifyFailure(last.outcome.observation, last.url).message };
  }
  return { ok: false, message: GITHUB_BAD_RESPONSE };
}

/** 供 store 拼错误占位路径用：第一候选（最常见的主干分支）的文件路径。 */
export function githubFirstPath(target: GithubTarget): string {
  return githubLocations(target)[0]?.path ?? '';
}
