/**
 * 拉取的 store 接缝（issue #4 · 第二层接缝：既有文件合并通道 + mock 传输）。
 *
 * 断言只看外部可见的结果：会话里的文件集合、来源与批次元数据、报错文案、发出的请求。
 * 传输是注入的假实现，所以「发了几次、发了什么」是可数的；解析走真 wasm
 * （helpers/wasm.ts），于是「拉取文件参与调用图」这条能被真断言，而不是假定。
 */
import type { PickedFile } from '../src/parser/types';
import { MAX_FILES, useAppStore } from '../src/state/store';
import { fileScope } from '../src/graph/scope';
import type { AppStore } from '../src/state/store';
import type { PullOutcome, PullTransport } from '../src/pull/transport';
import type { PullRequest } from '../src/pull/urls';
import { MAX_FILE_SIZE, oversizeMessage } from '../src/parser/analyze';
import { webPullTransport } from '../src/platform/web/pullFetch';
import { getTestParser, describeWasm } from './helpers/wasm';
import type { PythonParser } from '../src/parser/treeSitter';

/** 记录每一次请求的假传输：路由表按 URL 命中，没配路由的一律按 404 处理（断言里数 calls）。 */
interface FakeTransport extends PullTransport {
  calls: PullRequest[];
}

function fakeTransport(routes: Record<string, PullOutcome>): FakeTransport {
  const calls: PullRequest[] = [];
  return {
    calls,
    get: async (req) => {
      calls.push(req);
      return (
        routes[req.url] ?? {
          ok: false,
          observation: { type: 'status', status: 404, rateLimited: false },
        }
      );
    },
  };
}

/**
 * 假的会话存储：把 saveSession 写进来的东西原样存住，loadSession 再读出去。
 * 只有 IndexedDB 本身是假的，存取的**契约**（含 origins/batches 这两个新字段）走的是真代码路径。
 * 变量名必须以 mock 开头 —— babel-plugin-jest-hoist 只放行这个前缀进 jest.mock 工厂。
 */
const mockPersist: {
  saved: [unknown, unknown, unknown][];
  session: null | {
    files: PickedFile[];
    activeFile: string | null;
    timestamp: number;
    origins?: Record<string, { url: string; pulledAt: number }>;
    batches?: { sourceUrl: string; ref: string | null; paths: string[]; pulledAt: number }[];
  };
} = { saved: [], session: null };

jest.mock('../src/platform/web/persist', () => ({
  saveSession: async (files: unknown, activeFile: unknown, meta: unknown) => {
    mockPersist.saved.push([files, activeFile, meta]);
    const m = (meta ?? {}) as {
      origins?: Record<string, { url: string; pulledAt: number }>;
      batches?: { sourceUrl: string; ref: string | null; paths: string[]; pulledAt: number }[];
    };
    mockPersist.session = {
      files: files as PickedFile[],
      activeFile: activeFile as string | null,
      timestamp: 1,
      origins: m.origins,
      batches: m.batches,
    };
  },
  loadSession: async () => mockPersist.session,
  hasSession: async () => mockPersist.session !== null,
  clearSession: async () => {
    mockPersist.session = null;
  },
}));

const INITIAL = useAppStore.getState();
const s = (): AppStore => useAppStore.getState();

/** 一个函数一个调用的最小 Python 源，用来证明拉进来的文件真的参与了建图。 */
function pySource(func: string, calls?: string): string {
  return ['def ' + func + '():', '    return ' + (calls ?? '1'), ''].join('\n');
}

describeWasm('拉取进会话（store 接缝 · 真 wasm · mock 传输）', () => {
  let parser: PythonParser;

  beforeAll(async () => {
    parser = await getTestParser();
  });

  beforeEach(() => {
    mockPersist.saved = [];
    mockPersist.session = null;
    useAppStore.setState({ ...INITIAL, parser: null }, true);
  });

  it('一条 https 直链 -> 文件进会话、带来源、成一个批次，只发出一次 GET', async () => {
    const url = 'https://example.com/pkg/zz_probe_alpha.py';
    const transport = fakeTransport({
      [url]: { ok: true, text: pySource('zz_probe_alpha') },
    });

    const before = Date.now();
    await s().pullFromText(url, { parser, transport });
    const after = Date.now();

    // 只发了一次，而且发出去的就是用户给的那条 URL 加超时，没有别的东西
    expect(transport.calls).toEqual([{ url, timeoutMs: 15000 }]);

    const path = 'example.com/pkg/zz_probe_alpha.py';
    expect(s().files.map((f) => f.path)).toEqual([path]);
    expect(s().files[0]?.content).toContain('def zz_probe_alpha');
    expect(s().files[0]?.error).toBeUndefined();
    expect(s().status).toBe('ready');

    // 参与调用图：与本地文件同为一等公民
    expect(s().graph?.nodes.map((n) => n.id)).toContain(path + '::zz_probe_alpha');

    // 来源元数据可读
    expect(s().origins[path]).toEqual({ url, pulledAt: expect.any(Number) });
    const at = s().origins[path]?.pulledAt ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);

    // 一个 URL = 一个批次
    expect(s().batches).toEqual([
      { sourceUrl: url, ref: null, paths: [path], pulledAt: expect.any(Number) },
    ]);
    expect(s().pullIssues).toEqual([]);
  });

  it('非法 URL 一个请求都不发，只把理由交给用户', async () => {
    const transport = fakeTransport({});
    await s().pullFromText('http://example.com/a.py\nhttps://example.com/b.txt', {
      parser,
      transport,
    });
    expect(transport.calls).toEqual([]);
    expect(s().files).toEqual([]);
    expect(s().batches).toEqual([]);
    expect(s().origins).toEqual({});
    expect(s().pullIssues).toHaveLength(2);
    expect(s().pullIssues[0]).toMatch(/mixed content/i);
    expect(s().pullIssues[1]).toMatch(/\.py/);
    expect(s().pulling).toBe(false);
  });

  it('整段空白：提示一句，不发请求也不动会话', async () => {
    const transport = fakeTransport({});
    await s().pullFromText('   \n  \n', { parser, transport });
    expect(transport.calls).toEqual([]);
    expect(s().pullIssues).toHaveLength(1);
  });

  it('全是非法 URL 时不重解析既有会话（选择与范围不该被一次失败的粘贴重置）', async () => {
    const url = 'https://example.com/a/zz_probe_good.py';
    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: pySource('zz_probe_good') } }),
    });
    const id = 'example.com/a/zz_probe_good.py::zz_probe_good';
    s().selectFromGraph(id);
    const before = { selection: s().selection, scope: s().scope, fitNonce: s().fitNonce };

    const transport = fakeTransport({});
    await s().pullFromText('nonsense', { parser, transport });

    expect(transport.calls).toEqual([]);
    expect(s().selection).toEqual(before.selection);
    expect(s().scope).toEqual(before.scope);
    expect(s().fitNonce).toBe(before.fitNonce);
    expect(s().pullIssues).toHaveLength(1);
  });

  it('单文件失败只降级该文件：分类文案落在那个文件上，同批其余文件照常进图', async () => {
    const good = 'https://example.com/a/zz_probe_good.py';
    const bad = 'https://example.com/b/zz_probe_bad.py';
    const transport = fakeTransport({
      [good]: { ok: true, text: pySource('zz_probe_good') },
      [bad]: { ok: false, observation: { type: 'blocked', reachable: true } },
    });
    await s().pullFromText(good + '\n' + bad, { parser, transport });

    const byPath = new Map(s().files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([
      'example.com/a/zz_probe_good.py',
      'example.com/b/zz_probe_bad.py',
    ]);
    expect(byPath.get('example.com/a/zz_probe_good.py')?.error).toBeUndefined();
    expect(byPath.get('example.com/b/zz_probe_bad.py')?.error).toMatch(/CORS/);
    // 坏的走既有降级路径：黄条里点名，图里没有它
    expect(s().warnings.join(' | ')).toMatch(/CORS/);
    expect(s().graph?.nodes.map((n) => n.id)).toContain(
      'example.com/a/zz_probe_good.py::zz_probe_good'
    );
    expect(s().graph?.nodes.map((n) => n.id)).not.toContain(
      'example.com/b/zz_probe_bad.py::zz_probe_bad'
    );
    // 两个 URL = 两个批次；失败的那个也记了来源（#7 刷新要连它一起重试）
    expect(s().batches.map((b) => b.sourceUrl)).toEqual([good, bad]);
    expect(s().origins['example.com/b/zz_probe_bad.py']?.url).toBe(bad);
  });

  it('超 1MB（按实际字节）的文件不进会话，但留一个带现有超限文案的条目', async () => {
    const url = 'https://example.com/big/zz_probe_big.py';
    const tooBig = '中'.repeat(Math.floor(MAX_FILE_SIZE / 3) + 1);
    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: tooBig } }),
    });
    const f = s().files[0];
    expect(f?.path).toBe('example.com/big/zz_probe_big.py');
    expect(f?.content).toBe('');
    expect(f?.error).toBe(oversizeMessage());
    expect(s().graph?.nodes ?? []).toHaveLength(0);
  });

  it('撞上 20 文件上限：沿用现有那句文案，这一批一个都不合并，元数据也不写', async () => {
    const local: PickedFile[] = Array.from({ length: MAX_FILES - 1 }, (_, i) => ({
      path: 'local/f' + i + '.py',
      name: 'f' + i + '.py',
      content: pySource('zz_local_' + i),
    }));
    await s().loadFiles(local, parser);
    expect(s().files).toHaveLength(MAX_FILES - 1);

    const u1 = 'https://example.com/x/zz_probe_one.py';
    const u2 = 'https://example.com/y/zz_probe_two.py';
    await s().pullFromText(u1 + '\n' + u2, {
      parser,
      transport: fakeTransport({
        [u1]: { ok: true, text: pySource('zz_probe_one') },
        [u2]: { ok: true, text: pySource('zz_probe_two') },
      }),
    });

    expect(s().error).toBe(
      'Too many files: ' +
        (MAX_FILES + 1) +
        '/' +
        MAX_FILES +
        '. Please remove some files before adding more.'
    );
    expect(s().files).toHaveLength(MAX_FILES - 1);
    expect(s().origins).toEqual({});
    expect(s().batches).toEqual([]);
  });

  it('重复粘贴同一 URL：原位更新，文件与批次都不产生副本', async () => {
    const url = 'https://example.com/pkg/zz_probe_alpha.py';
    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: pySource('zz_probe_alpha', '1') } }),
    });
    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: pySource('zz_probe_alpha', '2') } }),
    });
    expect(s().files).toHaveLength(1);
    expect(s().files[0]?.content).toContain('return 2');
    expect(s().batches).toHaveLength(1);
    expect(s().batches[0]?.paths).toEqual(['example.com/pkg/zz_probe_alpha.py']);
  });

  it('只差一个 #L3 的同一条直链算同一个批次（片段既不发出去也不参与身份）', async () => {
    const base = 'https://example.com/pkg/zz_probe_alpha.py';
    await s().pullFromText(base, {
      parser,
      transport: fakeTransport({ [base]: { ok: true, text: pySource('zz_probe_alpha', '1') } }),
    });
    await s().pullFromText(base + '#L3', {
      parser,
      transport: fakeTransport({ [base]: { ok: true, text: pySource('zz_probe_alpha', '9') } }),
    });
    expect(s().files).toHaveLength(1);
    expect(s().batches).toHaveLength(1);
    expect(s().files[0]?.content).toContain('return 9');
  });

  it('多行粘贴 = 多个批次，逐批独立成败（一行不通不拖累其他行）', async () => {
    const ok1 = 'https://one.example.com/a/zz_probe_a.py';
    const bad = 'https://two.example.com/b/zz_probe_b.py';
    const ok2 = 'https://three.example.com/c/zz_probe_c.py';
    const transport = fakeTransport({
      [ok1]: { ok: true, text: pySource('zz_probe_a') },
      [bad]: { ok: false, observation: { type: 'status', status: 403, rateLimited: true } },
      [ok2]: { ok: true, text: pySource('zz_probe_c') },
    });
    await s().pullFromText([ok1, bad, ok2].join('\n'), { parser, transport });

    expect(transport.calls.map((c) => c.url)).toEqual([ok1, bad, ok2]);
    expect(s().batches.map((b) => b.sourceUrl)).toEqual([ok1, bad, ok2]);
    expect(
      s()
        .files.filter((f) => !f.error)
        .map((f) => f.path)
        .sort()
    ).toEqual(['one.example.com/a/zz_probe_a.py', 'three.example.com/c/zz_probe_c.py']);
    expect(s().files.find((f) => f.path === 'two.example.com/b/zz_probe_b.py')?.error).toMatch(
      /try again later/i
    );
  });

  it('删掉一个拉取文件：来源与批次路径跟着消失（刷新才不会把它复活）', async () => {
    const u1 = 'https://example.com/a/zz_probe_keep.py';
    const u2 = 'https://example.com/b/zz_probe_drop.py';
    await s().pullFromText(u1 + '\n' + u2, {
      parser,
      transport: fakeTransport({
        [u1]: { ok: true, text: pySource('zz_probe_keep') },
        [u2]: { ok: true, text: pySource('zz_probe_drop') },
      }),
    });
    expect(s().batches).toHaveLength(2);

    await s().removeFile('example.com/b/zz_probe_drop.py');

    expect(s().files.map((f) => f.path)).toEqual(['example.com/a/zz_probe_keep.py']);
    expect(s().origins['example.com/b/zz_probe_drop.py']).toBeUndefined();
    expect(s().origins['example.com/a/zz_probe_keep.py']?.url).toBe(u1);
    expect(s().batches.map((b) => b.sourceUrl)).toEqual([u1]);
  });

  it('来源与批次随会话快照存下来；重开页面读回来，且一个请求都不发', async () => {
    const url = 'https://example.com/pkg/zz_probe_alpha.py';
    const path = 'example.com/pkg/zz_probe_alpha.py';
    const content = pySource('zz_probe_alpha');
    const getSpy = jest.spyOn(webPullTransport, 'get');

    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: content } }),
    });

    // 快照里带上了批次元数据（来源 URL、ref、这一批的路径、拉取时刻）
    expect(mockPersist.session?.origins?.[path]?.url).toBe(url);
    expect(mockPersist.session?.batches).toEqual([
      { sourceUrl: url, ref: null, paths: [path], pulledAt: expect.any(Number) },
    ]);
    expect(mockPersist.session?.files.map((f) => f.path)).toEqual([path]);
    expect(getSpy).not.toHaveBeenCalled(); // 走的是注入的假传输，默认那个 fetch 外壳没被碰过

    // 「重开页面」= 空的 store（解析器仍要注入：真页面是自己去加载 wasm 的）
    useAppStore.setState({ ...INITIAL, parser }, true);
    expect(s().files).toEqual([]);
    await s().restoreSession();

    expect(s().files.map((f) => f.path)).toEqual([path]);
    expect(s().files[0]?.content).toBe(content);
    expect(s().origins[path]?.url).toBe(url);
    expect(s().batches.map((b) => b.sourceUrl)).toEqual([url]);
    expect(s().activeFile).toBe(path);
    expect(s().graph?.nodes.map((n) => n.id)).toContain(path + '::zz_probe_alpha');
    // 还原快照永不自动拉取（用户故事 10）
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it('旧快照没有来源/批次字段：读进来当本地文件，不报错', async () => {
    mockPersist.session = {
      files: [{ path: 'legacy.py', name: 'legacy.py', content: pySource('zz_legacy') }],
      activeFile: null,
      timestamp: 1,
    };
    useAppStore.setState({ ...INITIAL, parser }, true);
    await s().restoreSession();
    expect(s().files.map((f) => f.path)).toEqual(['legacy.py']);
    expect(s().origins).toEqual({});
    expect(s().batches).toEqual([]);
    expect(s().error).toBeNull();
    expect(s().graph?.nodes.map((n) => n.id)).toContain('legacy.py::zz_legacy');
  });
  it('传输外壳自己 reject：单文件降级、其余批次照常、pulling 不留成 true', async () => {
    const bad = 'https://crash.example.com/zz_crash.py';
    const good = 'https://example.com/pkg/zz_probe_alpha.py';
    const calls: PullRequest[] = [];
    const transport: PullTransport = {
      get: async (req) => {
        calls.push(req);
        if (req.url === bad) throw new Error('socket hang up');
        return { ok: true, text: pySource('zz_probe_alpha') };
      },
    };
    await s().pullFromText(bad + '\n' + good, { parser, transport });

    // 按钮不会被一个异常永久禁用
    expect(s().pulling).toBe(false);
    const crashed = s().files.find((f) => f.path === 'crash.example.com/zz_crash.py');
    expect(crashed?.error).toContain('failed unexpectedly');
    expect(crashed?.error).toContain('socket hang up');
    // 逐批独立成败：后一个批次照样进会话
    expect(s().files.map((f) => f.path)).toContain('example.com/pkg/zz_probe_alpha.py');
    expect(s().pullIssues).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('整轮一个文件都没拉成：占位与来源留下，但用户的范围/视图不被重置', async () => {
    const url = 'https://down.example.com/zz_down.py';
    await s().loadFiles(
      [{ path: 'local.py', name: 'local.py', content: pySource('zz_local') }],
      parser
    );
    // 合并而不是替换：replace=true 会把 action 一起抹掉
    useAppStore.setState({
      scope: fileScope('local.py::zz_local'),
      view: { tx: 12, ty: 34, scale: 1.5 },
    });
    const scopeBefore = s().scope;
    const viewBefore = s().view;

    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({}), // 没配路由 -> 每条都 404
    });

    // 失败的位置与来源照样进会话（红点就是它该有的样子，#7 刷新要连它一起重试）
    expect(
      s()
        .files.map((f) => f.path)
        .sort()
    ).toEqual(['down.example.com/zz_down.py', 'local.py']);
    expect(s().origins['down.example.com/zz_down.py']?.url).toBe(url);
    expect(s().batches.map((b) => b.sourceUrl)).toEqual([url]);
    // 但没有任何新内容进来：用户正在看的东西不该被拿走
    expect(s().scope).toEqual(scopeBefore);
    expect(s().view).toEqual(viewBefore);
    expect(s().pulling).toBe(false);

    // 对照：真有内容拉进来时仍是既有行为（新内容要看，视图回归默认）
    const ok = 'https://example.com/pkg/zz_probe_alpha.py';
    await s().pullFromText(ok, {
      parser,
      transport: fakeTransport({ [ok]: { ok: true, text: pySource('zz_probe_alpha') } }),
    });
    expect(s().scope).not.toEqual(scopeBefore);
    expect(s().view).not.toEqual(viewBefore);
  });

  it('Clear 之后拉取元数据一起清空', async () => {
    const url = 'https://example.com/pkg/zz_probe_alpha.py';
    await s().pullFromText(url, {
      parser,
      transport: fakeTransport({ [url]: { ok: true, text: pySource('zz_probe_alpha') } }),
    });
    expect(s().batches).toHaveLength(1);
    await s().reset();
    expect(s().files).toEqual([]);
    expect(s().origins).toEqual({});
    expect(s().batches).toEqual([]);
    expect(s().pullIssues).toEqual([]);
    expect(s().pulling).toBe(false);
  });
});
