/**
 * 拉取的传输接缝：接口与结果类型在这里，实现在 platform/web/pullFetch.ts。
 *
 * 为什么接口只有 get：承诺是「拉取只发出对用户所给 URL 的 GET、请求体恒空」（ADR-0006 窄事实）。
 * 接口上不存在 post/put、也没有 body 参数，于是这条承诺不靠自觉 —— 想违反得先改类型。
 * 冒烟 P1 再从真浏览器的网络记录上验一遍（方法全 GET、请求体字节数恒 0）。
 *
 * store 只依赖这个接口，所以 store 的单测可以注入假传输（issue #4 的第二层接缝）；
 * 外发的真 fetch 只存在于 platform/web 那一层（同源 wasm 资产那处不算，见 pullFetch.ts 头注），
 * 由真浏览器冒烟整体覆盖。
 */
import type { PullFailureObservation } from './errors';
import type { PullRequest } from './urls';

export type PullOutcome =
  { ok: true; text: string } | { ok: false; observation: PullFailureObservation };

export interface PullTransport {
  get(req: PullRequest): Promise<PullOutcome>;
}
