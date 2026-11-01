/**
 * 批次刷新（#7）：把「这一批还在会话里的路径」重新推导成一串 GET 请求。
 *
 * 纯推导，只吃批次元数据（sourceUrl / ref / paths），不发请求、不读时钟。
 * 判据来自 CONTEXT.md 的「刷新 = 按既有来源重新拉取」与 ADR-0006 的
 * 「刷新一个批次只产生该批次路径集的请求，不触碰其他批次」。
 *
 * 为什么不在刷新时重新走一遍分流 + 清单：批次元数据已经记下了当初那一次
 * 用户动作的结论（来源 URL、ref、路径集合），刷新是**重放**它，不是重新发现。
 * 重新拉一次 trees 既多一次请求，也会让「刷新只碰本批」这条从「一次/每文件」
 * 变成「不可数」。
 */

import type { PullBatch } from './batch';
import { GITHUB_BAD_RESPONSE, githubRawUrl, type GithubTarget } from './github';
import { PULL_TIMEOUT_MS, classifyUrl, pulledPathFor } from './urls';

/** 一个待刷新的文件：会话路径 + 由批次元数据确定性推导出的请求地址。 */
export interface BatchRefreshRequest {
  path: string;
  url: string;
  timeoutMs: number;
}

export type BatchRefreshPlan =
  | { ok: true; requests: BatchRefreshRequest[] }
  /** 元数据已经推导不出请求（源 URL 失效、路径对不上仓库）：把理由交给用户，一条都不发 */
  | { ok: false; message: string };

function request(path: string, url: string): BatchRefreshRequest {
  return { path, url, timeoutMs: PULL_TIMEOUT_MS };
}

/**
 * 批次里的 ref。直链批次不需要它；github 批次原则上都记了（#5 / #6 落地时就写进去了）。
 *
 * blob 的失败占位批次可能没记住 ref（matching-refs 那次也失败了）：那条批次当初的会话身份
 * 就是「首段当 ref」这个最常见的拆分，刷新沿用同一个拆分 —— 不另发明一种可能，
 * 否则刷新出来的路径会与已存在的占位条目对不上，等于凭空多一个文件。
 */
function refOf(target: GithubTarget, batch: PullBatch): string | null {
  if (batch.ref) return batch.ref;
  if (target.kind === 'blob' && target.rest.length > 1) return target.rest[0] ?? null;
  return null;
}

/** 一个批次 -> 重放请求；同一批次永远推导出同一组地址（确定性是冒烟 P4 的判据）。 */
export function batchRefreshPlan(batch: PullBatch): BatchRefreshPlan {
  const triage = classifyUrl(batch.sourceUrl);
  if (triage.kind === 'invalid') return { ok: false, message: triage.message };
  if (triage.kind === 'direct') {
    // 一条直链只产生一个会话身份；批次里出现别的路径说明元数据已经坏了，
    // 凭它发请求就是替一个不认识的文件拉正文。
    const path = pulledPathFor(triage.url);
    return {
      ok: true,
      requests: batch.paths.filter((p) => p === path).map((p) => request(p, triage.url)),
    };
  }

  const target = triage.target;
  const prefix = target.owner + '/' + target.repo + '/';
  const ref = refOf(target, batch);
  if (!ref) return { ok: false, message: GITHUB_BAD_RESPONSE };
  const requests = batch.paths
    .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
    .map((p) => request(p, githubRawUrl(target.owner, target.repo, ref, p.slice(prefix.length))));
  if (requests.length === 0) {
    return {
      ok: false,
      message:
        'This batch cannot be refreshed: its files no longer map back to the source repository',
    };
  }
  return { ok: true, requests };
}
