/**
 * 拉取的纯推导层（issue #4 · ADR-0006 决策 1/4）。
 *
 * 这一层是全功能唯一新增的接缝：纯输入 -> 纯输出，不发请求、不碰 DOM。
 * 断言只看外部可见的结果（分流结论、请求形状、会话里的路径、报错分类与文案），
 * 不看内部怎么分步骤 —— 所以这里的测试在 #5/#6 扩出 github 分流与清单解析后应当原样成立。
 */
import {
  classifyUrl,
  directRequest,
  pulledPathFor,
  splitPastedUrls,
  PULL_TIMEOUT_MS,
} from '../src/pull/urls';
import { normalizePath } from '../src/parser/modules';
import {
  MAX_FILE_SIZE,
  byteLengthOf,
  oversizeMessage,
  oversizeMessageOf,
} from '../src/parser/analyze';
import { classifyFailure, isRateLimited } from '../src/pull/errors';
import { upsertBatch } from '../src/pull/batch';
import {
  isLoopbackOrigin,
  wireUrlFor,
  PULL_BASE_OVERRIDE_KEY,
} from '../src/platform/web/pullFetch';
import type { PullTriage } from '../src/pull/urls';

/** 只在 kind === 'invalid' 时有意义；写出来是为了让断言读得到 reason/message 而不用 cast。 */
function invalidOf(t: PullTriage): { reason: string; message: string } {
  if (t.kind !== 'invalid') throw new Error('期望 invalid，实际 ' + t.kind);
  return t;
}

describe('URL 分流：任意主机的 https 直链', () => {
  it('把一条 https 的 .py 直链认成 direct', () => {
    expect(classifyUrl('https://example.com/libs/tool.py')).toEqual({
      kind: 'direct',
      url: 'https://example.com/libs/tool.py',
    });
  });

  it('.pyi 同样是直链；query 与 hash 不参与判断', () => {
    expect(classifyUrl('https://example.com/a/stubs.pyi').kind).toBe('direct');
    const withNoise = classifyUrl('https://example.com/libs/tool.py?raw=1#L10-L20');
    expect(withNoise.kind).toBe('direct');
  });

  it('首尾空白与前后空行不影响判断（用户是从别处粘过来的）', () => {
    expect(classifyUrl('  https://example.com/tool.py  ')).toEqual({
      kind: 'direct',
      url: 'https://example.com/tool.py',
    });
  });
});

describe('URL 分流：非法输入一律拒掉，且四种理由的文案互不相同', () => {
  it('http 明文按混合内容拒掉（这一条根本轮不到浏览器发请求）', () => {
    const r = invalidOf(classifyUrl('http://example.com/tool.py'));
    expect(r.reason).toBe('insecure');
    expect(r.message).toMatch(/mixed content/i);
    expect(r.message).toMatch(/https/);
  });

  it('路径不以 .py/.pyi 结尾的拒掉，哪怕它是个合法的 https URL', () => {
    const r = invalidOf(classifyUrl('https://example.com/libs/tool.txt'));
    expect(r.reason).toBe('not-python');
    expect(r.message).toMatch(/\.py/);
    // 只看路径后缀，不看 query：?raw=1 之类的参数不该让 .txt 蒙混过关
    expect(invalidOf(classifyUrl('https://example.com/tool.zip?x=1.py')).reason).toBe('not-python');
  });

  it('根本不是 URL 的字符串、空串、以及非 http(s) 协议各自有理由', () => {
    expect(invalidOf(classifyUrl('just some words')).reason).toBe('not-a-url');
    expect(invalidOf(classifyUrl('')).reason).toBe('empty');
    expect(invalidOf(classifyUrl('   \n  ')).reason).toBe('empty');
    expect(invalidOf(classifyUrl('ftp://example.com/tool.py')).reason).toBe('unsupported-scheme');
    expect(invalidOf(classifyUrl('file:///etc/passwd.py')).reason).toBe('unsupported-scheme');
  });

  it('理由不同文案就不同（用户要能一眼看出该改哪儿）', () => {
    const messages = [
      invalidOf(classifyUrl('http://example.com/a.py')).message,
      invalidOf(classifyUrl('https://example.com/a.txt')).message,
      invalidOf(classifyUrl('nope')).message,
      invalidOf(classifyUrl('')).message,
      invalidOf(classifyUrl('ftp://example.com/a.py')).message,
    ];
    expect(new Set(messages).size).toBe(messages.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(10);
  });
});

describe('直链请求推导：出去的只有用户给的那个 URL', () => {
  it('推导结果就是 URL 本身加一个超时，没有别的字段可以塞方法或请求体', () => {
    const u = 'https://example.com/libs/tool.py';
    expect(directRequest(u)).toEqual({ url: u, timeoutMs: PULL_TIMEOUT_MS });
  });

  it('超时是 15 秒（单请求上限，不是整批）', () => {
    expect(PULL_TIMEOUT_MS).toBe(15000);
  });

  it('query 原样带上、hash 不发出去（片段是浏览器侧的东西，服务端永远看不到）', () => {
    const t = classifyUrl('https://example.com/libs/tool.py?raw=1#L10-L20');
    if (t.kind !== 'direct') throw new Error('期望 direct');
    expect(t.url).toBe('https://example.com/libs/tool.py?raw=1');
    expect(directRequest(t.url).url).toBe('https://example.com/libs/tool.py?raw=1');
  });

  it('推导是确定性的：同一条输入永远得到同一个请求（批次身份就靠这个）', () => {
    const a = classifyUrl('https://example.com/x/y.py');
    const b = classifyUrl('  https://example.com/x/y.py#L3  ');
    if (a.kind !== 'direct' || b.kind !== 'direct') throw new Error('期望 direct');
    expect(a.url).toBe(b.url);
  });
});

describe('拉取文件路径计算：会话里的身份', () => {
  it('host + 路径，去掉开头的斜杠 —— 与会话里既有的路径写法同一种形状', () => {
    expect(pulledPathFor('https://example.com/libs/tool.py')).toBe('example.com/libs/tool.py');
    expect(pulledPathFor('https://example.com/tool.py')).toBe('example.com/tool.py');
    expect(
      pulledPathFor('https://raw.githubusercontent.com/psf/requests/main/src/requests/api.py')
    ).toBe('raw.githubusercontent.com/psf/requests/main/src/requests/api.py');
  });

  it('非默认端口留在身份里（本机桩与线上直链不能混成同一个文件）', () => {
    expect(pulledPathFor('https://localhost:8099/stub/probe.py')).toBe(
      'localhost:8099/stub/probe.py'
    );
  });

  it('不同主机上的同名文件互不覆盖（用户故事 8）', () => {
    const a = pulledPathFor('https://one.example.com/pkg/mod.py');
    const b = pulledPathFor('https://two.example.com/pkg/mod.py');
    expect(a).not.toBe(b);
    expect(a.endsWith('/pkg/mod.py')).toBe(true);
    expect(b.endsWith('/pkg/mod.py')).toBe(true);
  });

  it('query 不进路径；同一条直链带不带 ?raw=1 都是同一个文件', () => {
    expect(pulledPathFor('https://example.com/a/tool.py?raw=1')).toBe('example.com/a/tool.py');
    expect(pulledPathFor('https://example.com/a/tool.py')).toBe('example.com/a/tool.py');
  });

  it('算出来的路径再过一遍会话的 normalizePath 是恒等的（否则合并键会对不上）', () => {
    for (const u of [
      'https://example.com/libs/tool.py',
      'https://localhost:8099/stub/probe.py',
      'https://example.com/a/b/c/d.pyi',
    ]) {
      const p = pulledPathFor(u);
      expect(p.startsWith('/')).toBe(false);
      expect(normalizePath(p)).toBe(p);
    }
  });
});

describe('多行粘贴：一行一个批次', () => {
  it('按行切、去空白、丢空行，顺序保留', () => {
    expect(
      splitPastedUrls('  https://a.example.com/x.py  \n\nhttps://b.example.com/y.py\n   \n')
    ).toEqual(['https://a.example.com/x.py', 'https://b.example.com/y.py']);
  });

  it('整段空白切出 0 个批次（不是 1 个空批次）', () => {
    expect(splitPastedUrls('   \n \n')).toEqual([]);
    expect(splitPastedUrls('')).toEqual([]);
  });

  it('支持 Windows 的 CRLF 换行', () => {
    expect(splitPastedUrls('https://a.example.com/x.py\r\nhttps://b.example.com/y.py')).toEqual([
      'https://a.example.com/x.py',
      'https://b.example.com/y.py',
    ]);
  });

  it('不像 URL 的行也照样交出去 —— 判定与文案是 classifyUrl 的事，切分不替它做主', () => {
    expect(splitPastedUrls('hello\nhttps://a.example.com/x.py')).toEqual([
      'hello',
      'https://a.example.com/x.py',
    ]);
  });
});

describe('错误分类：四类文案互不相同', () => {
  const url = 'https://example.com/libs/tool.py';

  it('服务端答了错误状态码 -> http，文案里带上状态码与主机', () => {
    const r = classifyFailure({ type: 'status', status: 404, rateLimited: false }, url);
    expect(r.kind).toBe('http');
    expect(r.message).toMatch(/404/);
    expect(r.message).toMatch(/example\.com/);
  });

  it('5xx 同样归 http（不是「网络不可达」—— 服务器明明答话了）', () => {
    expect(classifyFailure({ type: 'status', status: 503, rateLimited: false }, url).kind).toBe(
      'http'
    );
  });

  it('限速单独一类，文案里明确让用户稍后再试', () => {
    const r = classifyFailure({ type: 'status', status: 403, rateLimited: true }, url);
    expect(r.kind).toBe('rate-limited');
    expect(r.message).toMatch(/403/);
    expect(r.message).toMatch(/try again later/i);
  });

  it('主机没答话 -> network（不可达），文案不把它说成站点坏了', () => {
    const r = classifyFailure({ type: 'blocked', reachable: false }, url);
    expect(r.kind).toBe('network');
    expect(r.message).toMatch(/example\.com/);
    expect(r.message).toMatch(/unreachable|could not reach|blocked/i);
  });

  it('15 秒超时归 network，但文案说的是超时（用户能分清「慢」和「不通」）', () => {
    const r = classifyFailure({ type: 'timeout' }, url);
    expect(r.kind).toBe('network');
    expect(r.message).toMatch(/15\s?s|15000|timed out/i);
  });

  it('主机答话了但不许这个页面读 -> cors，文案点名 CORS', () => {
    const r = classifyFailure({ type: 'blocked', reachable: true }, url);
    expect(r.kind).toBe('cors');
    expect(r.message).toMatch(/CORS/);
    expect(r.message).toMatch(/example\.com/);
  });

  it('传输外壳自己炸了 -> 也有一句人话（带上原因，不是一句笼统的失败）', () => {
    const r = classifyFailure({ type: 'crash', detail: 'socket hang up' }, url);
    expect(r.kind).toBe('network');
    expect(r.message).toMatch(/socket hang up/);
    expect(r.message).toMatch(/example\.com/);
  });

  it('四类的文案两两不同：网络不可达 / CORS / 4xx / 非法 URL', () => {
    const messages = [
      classifyFailure({ type: 'blocked', reachable: false }, url).message,
      classifyFailure({ type: 'blocked', reachable: true }, url).message,
      classifyFailure({ type: 'status', status: 404, rateLimited: false }, url).message,
      classifyFailure({ type: 'status', status: 403, rateLimited: true }, url).message,
      invalidOf(classifyUrl('http://example.com/tool.py')).message,
      classifyFailure({ type: 'crash', detail: 'x' }, url).message,
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('批次：一个路径同一时刻只属于一个批次', () => {
  const batch = (sourceUrl: string, paths: string[], pulledAt: number) => ({
    sourceUrl,
    ref: null,
    paths,
    pulledAt,
  });

  it('同一 URL 重复粘贴：原位更新（路径并集、时刻取新），不产生副本', () => {
    const one = upsertBatch([], batch('https://h/a.py', ['h/a.py'], 1));
    const two = upsertBatch(one, batch('https://h/a.py', ['h/b.py'], 2));
    expect(two).toHaveLength(1);
    expect(two[0]?.paths).toEqual(['h/a.py', 'h/b.py']);
    expect(two[0]?.pulledAt).toBe(2);
  });

  it('两条不同 URL 抢同一个路径：路径归新批次，旧批次被收空后整个丢掉', () => {
    // a.py 与 a.py?raw=1 的会话路径相同（query 不进路径）；若两个批次都握着它，
    // 刷新（#7）重放「该批路径」时就会替别的 URL 拉文件。
    const first = upsertBatch([], batch('https://h/a.py', ['h/a.py'], 1));
    const second = upsertBatch(first, batch('https://h/a.py?raw=1', ['h/a.py'], 2));
    expect(second).toEqual([batch('https://h/a.py?raw=1', ['h/a.py'], 2)]);
  });

  it('旧批次还有别的路径时只被收走重叠的那个，不整个丢掉', () => {
    const first = upsertBatch([], batch('https://h/repo', ['h/a.py', 'h/b.py'], 1));
    const second = upsertBatch(first, batch('https://h/a.py', ['h/a.py'], 2));
    expect(second.map((b) => b.sourceUrl).sort()).toEqual(['https://h/a.py', 'https://h/repo']);
    const repo = second.find((b) => b.sourceUrl === 'https://h/repo');
    expect(repo?.paths).toEqual(['h/b.py']);
  });
});

describe('限速识别：403 + 限速头才算限速', () => {
  it('429 一律是限速；403 只有带限速头才是', () => {
    expect(isRateLimited(429, {})).toBe(true);
    expect(isRateLimited(403, { 'x-ratelimit-remaining': '0' })).toBe(true);
    expect(isRateLimited(403, { 'X-RateLimit-Remaining': '0' })).toBe(true);
    expect(isRateLimited(403, { 'retry-after': '60' })).toBe(true);
    expect(isRateLimited(403, {})).toBe(false);
    expect(isRateLimited(403, { 'x-ratelimit-remaining': '42' })).toBe(false);
    expect(isRateLimited(404, { 'x-ratelimit-remaining': '0' })).toBe(false);
    expect(isRateLimited(200, { 'x-ratelimit-remaining': '0' })).toBe(false);
  });
});

describe('单文件上限按实际字节校验（不是字符数）', () => {
  it('边界就是解析层那个常量：正好 1MB 放行，多一个字节就超', () => {
    expect(oversizeMessageOf('x'.repeat(MAX_FILE_SIZE))).toBeNull();
    expect(oversizeMessageOf('x'.repeat(MAX_FILE_SIZE + 1))).toBe(oversizeMessage());
  });

  it('UTF-8 字节数：ASCII 1 字节、中文 3 字节、emoji 4 字节', () => {
    expect(byteLengthOf('')).toBe(0);
    expect(byteLengthOf('abc')).toBe(3);
    expect(byteLengthOf('中文')).toBe(6);
    expect(byteLengthOf(String.fromCodePoint(0x1f600))).toBe(4);
    // 落单的高代理项不是合法 UTF-8，按替换字符的 3 字节算，别算出 NaN
    expect(byteLengthOf('\ud800')).toBe(3);
  });

  it('字符数没超而字节数超了 —— 中文内容正是这一条要抓的', () => {
    const chars = Math.floor(MAX_FILE_SIZE / 3) + 1;
    expect(chars).toBeLessThanOrEqual(MAX_FILE_SIZE);
    expect(byteLengthOf('中'.repeat(chars))).toBeGreaterThan(MAX_FILE_SIZE);
    expect(oversizeMessageOf('中'.repeat(chars))).toBe(oversizeMessage());
  });

  it('超限文案沿用现有那一条（不新造一句），并且说的是 1MB', () => {
    expect(oversizeMessage()).toMatch(/1MB/);
  });
});
/**
 * base URL 覆盖（ADR-0006 决策 4：「仅冒烟/dev 生效的 base URL 覆盖参数」）。
 *
 * 这一组是**安全边界**而不只是测试便利：覆盖一旦在线上生效，就等于页面可以被诱导读一个
 * 用户没给的地址。闸门是「页面自己的源是不是回环」—— 冒烟（127.0.0.1:8099）与 npm run web
 * （localhost:19006）都算，任何线上域名都不算。
 */
describe('base URL 覆盖只在 dev/冒烟生效', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    delete g[PULL_BASE_OVERRIDE_KEY];
  });

  it('回环源认，线上域名不认（含拿回环当子域名骗人的那种）', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:8099')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:19006')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:8099')).toBe(true);
    expect(isLoopbackOrigin('https://codemap.example.com')).toBe(false);
    expect(isLoopbackOrigin('https://127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackOrigin('https://localhost.example.com')).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
  });

  it('没有覆盖时原样发出：用户给什么就是什么', () => {
    const url = 'https://example.com/pkg/tool.py?raw=1';
    expect(wireUrlFor(url)).toBe(url);
  });

  it('有覆盖时只换 origin 与前缀，pathname 与 query 一个字不改（冒烟 P2 的推导规则就是这一条）', () => {
    g[PULL_BASE_OVERRIDE_KEY] = 'http://127.0.0.1:8099/__pull-stub__';
    expect(wireUrlFor('https://pull-stub.invalid/probe/zz_pull_probe.py')).toBe(
      'http://127.0.0.1:8099/__pull-stub__/probe/zz_pull_probe.py'
    );
    // 带 query 与不带尾斜杠的 base 都要一样可推导
    expect(wireUrlFor('https://pull-stub.invalid/a/b.py?raw=1')).toBe(
      'http://127.0.0.1:8099/__pull-stub__/a/b.py?raw=1'
    );
    g[PULL_BASE_OVERRIDE_KEY] = 'http://127.0.0.1:8099/__pull-stub__/';
    expect(wireUrlFor('https://pull-stub.invalid/a/b.py')).toBe(
      'http://127.0.0.1:8099/__pull-stub__/a/b.py'
    );
  });
});
