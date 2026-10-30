/**
 * 拉取的传输外壳：全站**唯一**的外发 fetch（platform/web 的「唯一触点」惯例，同 filePick / persist）。
 * 页面里另一处 fetch 在 src/parser/treeSitter.ts：它取同源 wasm 资产，不是外发点 —— 这两处别混。
 *
 * 这一层刻意做得很薄：把 PullRequest 交给 fetch，把 fetch 的结果/异常翻译成 PullOutcome，
 * 不做任何策略判断 —— 该不该发这条请求是 classifyUrl 的事，失败算哪一类是 classifyFailure 的事。
 * 它依赖浏览器语义（TypeError、opaque 响应、AbortController），所以由真浏览器冒烟整体覆盖，
 * 不写 jsdom 单测（jsdom 里 typeof fetch === 'undefined'，测了也是在测 polyfill）。
 *
 * 外发申报：这里的 fetch 就是 ADR-0006 决策 4 说的那个「以 --allow-token 显式申报的合法外发点」。
 * 本轮（issue #4）还没把本文件加进 npm run audit:egress 的扫描范围 —— 那是 issue #9「外发审计扩扫」
 * 的活；提前加会连带需要放宽 --allow-token，而那个参数是全局的，一放宽就把 contact.ts
 * 「没有任何请求原语」这条既有保证一起放掉了。#9 需要的是按文件申报的能力。
 */
import { isRateLimited } from '../../pull/errors';
import type { PullFailureObservation } from '../../pull/errors';
import type { PullOutcome, PullTransport } from '../../pull/transport';
import type { PullRequest } from '../../pull/urls';

/**
 * base URL 覆盖的全局量名字。只有冒烟与 dev 会设它（browser-verify.mjs 用
 * Page.addScriptToEvaluateOnNewDocument 在文档创建前写进去），线上没人设，也就没人能设 ——
 * 见 overrideBase() 的回环源闸门。
 */
export const PULL_BASE_OVERRIDE_KEY = '__CODEMAP_PULL_BASE__';

/**
 * CORS 探针的超时：主请求已经等过 15s 了，探针只是判个「主机在不在」，别再等一轮。
 *
 * 口径说明：spec 的「单请求超时 15s」是**每一个请求**的上限（主请求 15s、探针 5s，
 * 各自都不超）；失败路径上用户感知的最坏等待因此是 15s + 5s，这是分类的代价，
 * 不是超时失效。成功路径上永远只有一个请求、上限就是 15s。
 */
const PROBE_TIMEOUT_MS = 5000;

function pageOrigin(): string | null {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    return window.location.origin ?? null;
  } catch {
    return null;
  }
}

/**
 * 回环源判定：localhost / 127.0.0.1 / [::1]。
 *
 * 这是「覆盖参数仅 dev/冒烟生效」的实现方式。不用 __DEV__：冒烟跑的是**生产产物**
 * （被测字节 == 上线字节，见 scripts/browser-verify.mjs 的 S 组），那里 __DEV__ 是 false，
 * 覆盖会失效；而用「页面自己的源是不是回环」判断，冒烟与 npm run web 都能用，
 * 线上域名（任何非回环源）永远拿不到这个能力 —— 拿不到就意味着请求按用户给的 URL 原样发出。
 */
export function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) return false;
  const m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^:/?#]+)/i.exec(origin);
  const host = (m?.[1] ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** 当前生效的 base 覆盖；没有（或不在回环源上）就是 null。 */
export function overrideBase(): string | null {
  if (!isLoopbackOrigin(pageOrigin())) return null;
  const v = (globalThis as unknown as Record<string, unknown>)[PULL_BASE_OVERRIDE_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * 真正发到网上的 URL：有覆盖时只换 origin 与一段前缀，**pathname 与 query 原样保留**。
 * 保留 pathname 是冒烟 P2 的判据 —— 「每个发出的 URL 都能由用户输入确定性推导」，
 * 推导规则就是下面这一行拼接，桩路径与用户给的路径一一对应，没有第二种可能。
 *
 * 不用 new URL(pathname, base)：那条标准解析会把 base 的路径当成「文件」整段替换掉
 * （'/a.py' 相对 'http://h/__stub__' 解析成 'http://h/a.py'），前缀就没了。
 * 这里要的是前缀语义，所以按段拼，并且把 base 的尾斜杠归一掉，多一个少一个都一样。
 */
export function wireUrlFor(url: string): string {
  const base = overrideBase();
  if (!base) return url;
  const u = new URL(url);
  const b = new URL(base);
  const prefix = b.pathname.replace(/\/+$/, '');
  return b.origin + prefix + u.pathname + u.search;
}

async function timedFetch(
  url: string,
  timeoutMs: number,
  init: RequestInit
): Promise<{ res?: Response; timedOut: boolean }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, timedOut };
  } catch (e) {
    return {
      timedOut: timedOut || (e instanceof Error && e.name === 'AbortError'),
      res: undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主机在不在：同一条 URL 再发一次 no-cors 的 GET。
 * 浏览器里「不通」与「被 CORS 拒」都是 TypeError，只有这个探针能分开（详见 pull/errors.ts）。
 * 探针拿不到内容（opaque），也不需要 —— 能 resolve 就说明主机答话了。
 */
async function probeReachable(url: string): Promise<boolean> {
  try {
    const { res, timedOut } = await timedFetch(url, PROBE_TIMEOUT_MS, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
    });
    return !timedOut && !!res;
  } catch {
    return false;
  }
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export const webPullTransport: PullTransport = {
  get: async (req: PullRequest): Promise<PullOutcome> => {
    const wire = wireUrlFor(req.url);
    const { res, timedOut } = await timedFetch(wire, req.timeoutMs, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
    if (timedOut || !res) {
      if (timedOut) return { ok: false, observation: { type: 'timeout' } };
      // fetch 抛了：先分清是「不通」还是「被 CORS 拒」，再交给 classifyFailure 出文案
      const observation: PullFailureObservation = {
        type: 'blocked',
        reachable: await probeReachable(wire),
      };
      return { ok: false, observation };
    }
    if (!res.ok) {
      const headers = headersOf(res);
      return {
        ok: false,
        observation: {
          type: 'status',
          status: res.status,
          rateLimited: isRateLimited(res.status, headers),
        },
      };
    }
    try {
      return { ok: true, text: await res.text() };
    } catch {
      // 响应头是 200 但正文读不出来（连接被掐断）：按不可达报，别把半个文件当成功
      return { ok: false, observation: { type: 'blocked', reachable: false } };
    }
  },
};
