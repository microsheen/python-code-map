/**
 * 拉取失败的分类与文案（issue #4 · ADR-0006「后果」最后一条）。
 *
 * 纯函数：只吃「传输层观察到了什么」，吐「属于哪一类 + 给用户看的那句话」。
 * 为什么要分类而不是一句「失败了」：大陆网络下 github 拉不通是常态，笼统一句失败会被读成
 * 「这个站点坏了」，而真相是「你的网络到那台主机不通」或「对方不许这个页面读」。
 *
 * 四类用户可见的分类（issue #4 验收标准）：网络不可达 / 被 CORS 拒绝 / 4xx / 非法 URL。
 * 前三类在这里，第四类是 classifyUrl 的 invalid 结论（它压根不发请求）。
 * 限速是 4xx 的一个子类，单独一类是因为它的处置动作不同：等一会儿再试，而不是去改链接。
 */
import { GITHUB_API_HOST, GITHUB_RAW_HOST } from './github';
import { PULL_TIMEOUT_MS } from './urls';

export type PullFailureKind = 'network' | 'cors' | 'http' | 'rate-limited';

/**
 * 传输层的观察结果。
 *
 * `blocked` 需要解释一句：浏览器里「主机不通」与「被 CORS 拒」都表现为 fetch 抛 TypeError，
 * 错误文本一模一样，光看异常分不出来。所以传输外壳在失败后会用同一条 URL 再发一次
 * `mode: 'no-cors'` 的 GET 探一下 —— 探得通说明主机在、只是没给 CORS 头（reachable=true），
 * 探不通才是真的不可达。探针只打用户给的那一条 URL、仍是 GET、仍无请求体，
 * 不违反 ADR-0006 的窄事实；分类本身在这里是纯的，好测。
 */
export type PullFailureObservation =
  | { type: 'status'; status: number; rateLimited: boolean }
  | { type: 'timeout' }
  | { type: 'blocked'; reachable: boolean }
  /** 传输外壳自己炸了（不该发生；store 把 reject 翻译成这一类，单文件降级） */
  | { type: 'crash'; detail: string };

export interface PullFailure {
  kind: PullFailureKind;
  /** 直接给用户看的英文文案 */
  message: string;
}

/** 文案里点出主机名：用户要能看出是哪台主机不通，而不是怀疑整个站点。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * GitHub 匿名限速 60 次/小时/IP（ADR-0006 证据）。403 既可能是限速也可能是真的没权限，
 * 靠限速头区分：`x-ratelimit-remaining: 0` 或 `retry-after`。429 一律按限速处理。
 * 头名大小写不敏感，所以先统一小写再查。
 */
export function isRateLimited(status: number, headers: Record<string, string>): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const h: Record<string, string> = {};
  for (const k of Object.keys(headers ?? {})) {
    const v = headers[k];
    if (v !== undefined) h[k.toLowerCase()] = v;
  }
  return h['x-ratelimit-remaining'] === '0' || !!h['retry-after'];
}

/** 观察结果 -> 分类 + 文案。 */
export function classifyFailure(obs: PullFailureObservation, url: string): PullFailure {
  const host = hostOf(url);
  if (obs.type === 'timeout') {
    return {
      kind: 'network',
      message: `Timed out after ${Math.round(PULL_TIMEOUT_MS / 1000)}s reaching ${host} — the host is too slow or your network blocked it`,
    };
  }
  if (obs.type === 'blocked') {
    return obs.reachable
      ? {
          kind: 'cors',
          message: `Blocked by CORS: ${host} answered but did not let this page read the file`,
        }
      : {
          kind: 'network',
          message: `Could not reach ${host} — your network blocked it or the host is down`,
        };
  }
  if (obs.type === 'crash') {
    return {
      kind: 'network',
      message: `Pulling ${host} failed unexpectedly (${obs.detail}) — please try again`,
    };
  }
  if (obs.rateLimited) {
    return {
      kind: 'rate-limited',
      message: `HTTP ${obs.status} from ${host} — rate limited, try again later`,
    };
  }
  // GitHub API 的 401/403/404 都可能是「仓库是私有的」（匿名拿不到）。#5 不接受任何认证，
  // 所以这里不提示登录、不提示 token，只把「只支持公开仓库」这一句直接给用户。
  // 404 还有第二种解释：分支名或目录写错（匿名下两者在 API 上分不开），所以 404 多给一句，
  // 免得用户拿着一模一样的链接反复重试。raw 主机的 401 是「这条内容要鉴权」，同一句话。
  if (
    (host === GITHUB_RAW_HOST && obs.status === 401) ||
    (host === GITHUB_API_HOST && (obs.status === 401 || obs.status === 403 || obs.status === 404))
  ) {
    const base = `HTTP ${obs.status} from ${host} — private repositories are not supported; only public repositories can be pulled`;
    return {
      kind: 'http',
      message: host === GITHUB_API_HOST && obs.status === 404 ? `${base}. The branch or path may also be wrong.` : base,
    };
  }
  // 5xx 是对方答话了但答的是「我这边出错」—— 叫用户去改链接是错建议（ADR-0006「文案避免被误读成
  // 站点坏了」的反方向）。4xx 才是「文件不在这儿 / 地址不对」，这时指向链接才有用。
  if (obs.status >= 500) {
    return {
      kind: 'http',
      message: `HTTP ${obs.status} from ${host} — the host answered with a server error; try again later`,
    };
  }
  return {
    kind: 'http',
    message: `HTTP ${obs.status} from ${host} — the file may have moved or the link may be wrong`,
  };
}
