/**
 * 拉取的元数据模型：来源（origin）与批次（batch）。
 *
 * 术语按 CONTEXT.md：来源 = 一个拉取文件的来历（它被拉取的 URL 与拉取时刻）；
 * 批次 = 一次用户发起的拉取所产生的文件集合，共享一次来源，是刷新的单位。
 * 这两样都随会话快照持久化（issue #4），所以它们是数据模型而不是 UI 状态。
 *
 * 批次身份就是来源 URL 本身，所以这里**没有** id 字段：再立一个 id 就等于承认
 * 「同一条 URL 可以是两个批次」，而验收标准要的正是「重复粘贴同一 URL 原位更新而不产生副本」。
 */

/** 一个拉取文件的来源。本地文件没有来源（这就是它俩的区别）。 */
export interface FileOrigin {
  /** 拉取它的那条 URL（用户输入经 classifyUrl 归一化后的形态：不含 hash） */
  url: string;
  /** 拉取时刻，epoch ms */
  pulledAt: number;
}

/** 一个拉取批次。 */
export interface PullBatch {
  /** 来源 URL，同时就是批次身份 */
  sourceUrl: string;
  /** 直链没有 ref；github 分流（#5）才会填分支/标签/commit */
  ref: string | null;
  /** 这一批在会话里占了哪些路径（含拉失败的占位条目，刷新时要一并重试） */
  paths: string[];
  pulledAt: number;
}

/** path -> 来源。只保存真有来源的那些，本地文件不在里面。 */
export type OriginMap = Record<string, FileOrigin>;

/**
 * 按同一 sourceUrl 原位更新批次：有就替换（paths 取并集，时刻取新的），没有就追加。
 * 「重复粘贴同一 URL 原位更新而不产生副本」这条就是靠它成立的。
 */
export function upsertBatch(batches: PullBatch[], next: PullBatch): PullBatch[] {
  // 一个路径同一时刻只属于一个批次：同名 last-write-wins 的批次版。
  // 不然 a.py 与 a.py?raw=1 两条 URL 会各自握着一个批次却指着同一个路径，
  // 刷新（#7）重放「该批路径」时就会替别的 URL 拉文件。
  const taken = new Set(next.paths);
  const rest = batches
    .filter((b) => b.sourceUrl !== next.sourceUrl)
    .map((b) => ({ ...b, paths: b.paths.filter((p) => !taken.has(p)) }))
    .filter((b) => b.paths.length > 0);
  const i = batches.findIndex((b) => b.sourceUrl === next.sourceUrl);
  if (i < 0) return [...rest, next];
  const prev = batches[i] as PullBatch;
  const paths = [...new Set([...prev.paths, ...next.paths])];
  return [...rest, { ...next, paths }];
}

/** 会话里已经不存在的文件，来源也跟着去掉：不变量是 origins ⊆ files。 */
export function pruneOrigins(origins: OriginMap, paths: Iterable<string>): OriginMap {
  const alive = new Set(paths);
  const out: OriginMap = {};
  for (const p of Object.keys(origins)) {
    const o = origins[p];
    if (o && alive.has(p)) out[p] = o;
  }
  return out;
}

/**
 * 批次里只留还在会话中的路径；一个路径都不剩的批次整个丢掉。
 * 这条是用户故事 12（「我删掉的某个拉取文件不应被后续刷新复活」）的地基：
 * 刷新重放的是「当前仍在会话中的该批路径」，删掉的既不在 files 里、也不该留在批次里。
 */
export function pruneBatches(batches: PullBatch[], paths: Iterable<string>): PullBatch[] {
  const alive = new Set(paths);
  const out: PullBatch[] = [];
  for (const b of batches) {
    const kept = b.paths.filter((p) => alive.has(p));
    if (kept.length > 0) out.push({ ...b, paths: kept });
  }
  return out;
}
