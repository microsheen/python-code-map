/**
 * 拉取的 UI 接缝（issue #4）：空态面板的粘贴入口、文件标签上的来源标识、顶栏的报错条。
 *
 * 断言只看用户能看见/能读到的东西：按钮在不在、粘贴之后 store 收到了什么、标签上读不读得到
 * 来源 URL 与拉取时刻。样式与布局不进断言（那是冒烟截图的活）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PullEntryDialog } from '../src/components/PullEntryDialog';
import { PullListingDialog } from '../src/components/PullListingDialog';
import { UploadPanel } from '../src/components/UploadPanel';
import { TopBar } from '../src/components/TopBar';
import { MAX_FILES, useAppStore } from '../src/state/store';
import type { AppStore } from '../src/state/store';
import { MAX_FILE_SIZE } from '../src/parser/analyze';
import type { GithubListing } from '../src/pull/github';

const INITIAL = useAppStore.getState();

function preset(extra: Partial<AppStore>): void {
  useAppStore.setState({ ...INITIAL, ...extra }, true);
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ ...INITIAL }, true);
});

/** 把 pullFromText 换成可断言的假实现，返回它收到的调用；extra 与假实现同一次 preset 进 store。 */
function stubPull(
  impl?: (text: string) => Promise<void>,
  extra?: Partial<AppStore>
): { calls: string[] } {
  const calls: string[] = [];
  preset({
    ...extra,
    pullFromText: async (text: string) => {
      calls.push(text);
      await (impl ? impl(text) : Promise.resolve());
    },
  } as Partial<AppStore>);
  return { calls };
}

describe('空态上传面板：Pull from URL 入口', () => {
  it('面板上有 "Pull from URL" 按钮（文案就是 spec 里那个）', () => {
    preset({});
    render(<UploadPanel />);
    expect(screen.getByTestId('upload-pull').textContent).toBe('Pull from URL');
  });

  it('面板的提示写明两个入口：这里与顶栏，开的是同一个对话框（issue #8 AC6）', () => {
    preset({});
    const { container } = render(<UploadPanel />);
    const text = container.textContent ?? '';
    expect(text).toContain('Pull from URL');
    expect(text).toContain('top bar');
  });

  it('既有的窄事实文案没被挤掉（承诺面那道门读的就是这段文本）', () => {
    preset({});
    const { container } = render(<UploadPanel />);
    const text = container.textContent ?? '';
    expect(text).toContain('drag files anywhere on the page');
    expect(text).toContain('explicitly pull');
    expect(text).toContain('never sent anywhere');
    expect(text).not.toContain('never leaves the browser');
  });

  it('点面板入口：打开的是共用对话框（store 的 pullEntryOpen 置真，对话框本体在 PullEntryDialog）', () => {
    preset({});
    render(<UploadPanel />);
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
    fireEvent.click(screen.getByTestId('upload-pull'));
    expect(useAppStore.getState().pullEntryOpen).toBe(true);
  });
});

describe('拉取粘贴对话框（issue #8 · 顶栏与空态面板共用的同一个）', () => {
  it('默认关着：点开之前没有粘贴框，也不采集任何输入', () => {
    const pull = stubPull();
    render(<PullEntryDialog />);
    expect(screen.queryByTestId('pull-dialog')).toBeNull();
    expect(screen.queryByTestId('pull-input')).toBeNull();
    expect(pull.calls).toEqual([]);
  });

  it('打开之后有粘贴框与确认按钮', () => {
    stubPull();
    preset({ pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    expect(screen.queryByTestId('pull-dialog')).not.toBeNull();
    expect(screen.queryByTestId('pull-input')).not.toBeNull();
    expect(screen.queryByTestId('pull-submit')).not.toBeNull();
  });

  it('粘贴多行再确认：store 收到的就是那段原文（多行 = 多个批次，切分是 store 的事）', async () => {
    const pull = stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    const text = 'https://one.example.com/a.py\nhttps://two.example.com/b.py';
    fireEvent.change(screen.getByTestId('pull-input'), { target: { value: text } });
    // 确认之后的收尾（清空粘贴框、收起对话框）落在 .then 的微任务里，要跟点击一起裹进 act
    await act(async () => {
      fireEvent.click(screen.getByTestId('pull-submit'));
    });
    expect(pull.calls).toEqual([text]);
  });

  it('拉取收尾：确认之后对话框自己收起来（跟取消按钮那条对称）', async () => {
    stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    fireEvent.change(screen.getByTestId('pull-input'), {
      target: { value: 'https://one.example.com/a.py' },
    });
    expect(screen.queryByTestId('pull-dialog')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pull-submit'));
    });
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
    expect(screen.queryByTestId('pull-dialog')).toBeNull();
    expect(screen.queryByTestId('pull-input')).toBeNull();
  });

  it('空粘贴点确认：不触发拉取（连一句提示都不必发请求）', () => {
    const pull = stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    fireEvent.change(screen.getByTestId('pull-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pull-submit'));
    expect(pull.calls).toEqual([]);
  });

  it('拉取进行中：确认按钮禁用，免得连点发出重复请求', () => {
    const pull = stubPull(undefined, {
      pullEntryOpen: true,
      pulling: true,
    } as Partial<AppStore>);
    render(<PullEntryDialog />);
    fireEvent.change(screen.getByTestId('pull-input'), {
      target: { value: 'https://one.example.com/a.py' },
    });
    fireEvent.click(screen.getByTestId('pull-submit'));
    expect(pull.calls).toEqual([]);
  });

  it('取消按钮把对话框收起来，不发请求', () => {
    const pull = stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    fireEvent.click(screen.getByTestId('pull-cancel'));
    expect(screen.queryByTestId('pull-input')).toBeNull();
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
    expect(pull.calls).toEqual([]);
  });

  it('Escape 也把对话框收起来（与勾选清单模态同一套键盘习惯）', () => {
    stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);
    expect(screen.queryByTestId('pull-dialog')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
  });

  it('顶栏入口与空态入口打开同一个对话框：全屏永远只有一份 pull-dialog', () => {
    stubPull();
    render(
      <>
        <TopBar />
        <UploadPanel />
        <PullEntryDialog />
      </>
    );
    fireEvent.click(screen.getByTestId('upload-pull'));
    expect(screen.getAllByTestId('pull-dialog')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('pull-cancel'));
    expect(screen.queryByTestId('pull-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('topbar-pull'));
    expect(screen.getAllByTestId('pull-dialog')).toHaveLength(1);
    expect(screen.queryByTestId('pull-input')).not.toBeNull();
  });

  it('拉取途中关掉再重开：旧提交的收尾不许收掉新对话框、清掉新草稿（review 竞态）', async () => {
    let resolvePull: (() => void) | null = null;
    stubPull(
      () =>
        new Promise<void>((resolve) => {
          resolvePull = resolve;
        }),
      { pullEntryOpen: true } as Partial<AppStore>
    );
    render(<PullEntryDialog />);
    fireEvent.change(screen.getByTestId('pull-input'), {
      target: { value: 'https://one.example.com/a.py' },
    });
    fireEvent.click(screen.getByTestId('pull-submit'));

    // 拉取还在飞：Escape 关掉，再从入口重开、输入新草稿 —— 对话框已经换过一茬
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
    act(() => {
      useAppStore.getState().setPullEntryOpen(true);
    });
    fireEvent.change(screen.getByTestId('pull-input'), {
      target: { value: 'https://two.example.com/b.py' },
    });

    await act(async () => {
      resolvePull!();
    });
    expect(useAppStore.getState().pullEntryOpen).toBe(true);
    expect((screen.getByTestId('pull-input') as HTMLTextAreaElement).value).toBe(
      'https://two.example.com/b.py'
    );
  });

  it('遮罩点击关掉对话框，点面板本身不关（stopPropagation 的另一半）', () => {
    stubPull(undefined, { pullEntryOpen: true } as Partial<AppStore>);
    render(<PullEntryDialog />);

    // 遮罩层没有 testid（与 PullListingDialog 同惯例），按 panel 的父级取
    const overlay = screen.getByTestId('pull-dialog').parentElement as HTMLElement;
    fireEvent.click(screen.getByTestId('pull-dialog'));
    expect(useAppStore.getState().pullEntryOpen).toBe(true);

    fireEvent.click(overlay);
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
  });
});

describe('顶栏：Pull from URL 常驻入口（issue #8 AC1）', () => {
  it('空态与有文件态入口都在（双入口并存，不随会话有无消失）', () => {
    preset({});
    const { unmount } = render(<TopBar />);
    expect(screen.getByTestId('topbar-pull').textContent).toBe('Pull from URL');
    unmount();

    preset({
      files: [{ path: 'a.py', name: 'a.py', content: 'def a():\n    pass\n', lines: [] }],
    } as Partial<AppStore>);
    render(<TopBar />);
    expect(screen.getByTestId('topbar-pull').textContent).toBe('Pull from URL');
  });

  it('点顶栏入口：打开共用对话框', () => {
    preset({});
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-pull'));
    expect(useAppStore.getState().pullEntryOpen).toBe(true);
  });

  it('解析中入口禁用：busy 时点不开对话框（与空态入口同一套门控）', () => {
    preset({ status: 'parsing', progress: { done: 1, total: 2 } } as Partial<AppStore>);
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-pull'));
    expect(useAppStore.getState().pullEntryOpen).toBe(false);
  });
});

describe('顶栏文件标签：拉取文件的来源可读', () => {
  // 应用里的「文件标签」就是顶栏这一排 chips：CodePane/FileTabs.tsx 早已从组件树上摘掉
  // （browser-verify.mjs 里两处 "FileTabs removed" 注释记着这件事），只有 chips 是用户真能看见的。
  const path = 'example.com/pkg/tool.py';
  const url = 'https://example.com/pkg/tool.py';
  const at = Date.UTC(2026, 9, 30, 1, 2, 3);
  const iso = new Date(at).toISOString();

  function presetChips(origins: Record<string, { url: string; pulledAt: number }>): void {
    preset({
      files: [
        { path, name: 'tool.py', content: 'def f():\n    pass\n', lines: [] },
        { path: 'local.py', name: 'local.py', content: 'def g():\n    pass\n', lines: [] },
      ],
      activeFile: path,
      origins,
    } as Partial<AppStore>);
  }

  it('拉取文件带标识，来源 URL 与拉取时刻作为元数据读得出来', () => {
    presetChips({ [path]: { url, pulledAt: at } });
    render(<TopBar />);

    expect(screen.queryByTestId('pull-origin-' + path)).not.toBeNull();
    // 本地文件没有来源，也就没有标识 —— 这个区别就是「拉取文件」这个词的全部内容
    expect(screen.queryByTestId('pull-origin-local.py')).toBeNull();

    // data-* 挂在 chip 外层的 web 包装 div 上：RN-web 的 Pressable 不转发 data-*/title
    // （实测 outerHTML 里一个都不剩），所以元数据的宿主只能是这层原生 div。
    const host = screen.getByTestId('chip-' + path).parentElement as HTMLElement;
    expect(host.getAttribute('data-pull-url')).toBe(url);
    expect(host.getAttribute('data-pull-at')).toBe(iso);
    const localHost = screen.getByTestId('chip-local.py').parentElement as HTMLElement;
    expect(localHost.getAttribute('data-pull-url')).toBeNull();
  });

  it('悬浮提示里读得到来源：路径、URL、拉取时刻（不靠开发者工具）', () => {
    presetChips({ [path]: { url, pulledAt: at } });
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    const tip = screen.getByTestId('chip-tooltip-' + path);
    expect(tip.textContent).toContain(path);
    expect(tip.textContent).toContain(url);
    expect(tip.textContent).toContain(iso);
  });

  it('路径本身以 pull- 开头也不会跟标识撞名（两个 testid 必须指向两个不同元素）', () => {
    // 标签恒以 chip- 开头、标识恒以 pull-origin- 开头：两个命名空间不相交，
    // 任何路径（包括 pull-thing.py 这种）都不可能撞上别人的元素。
    preset({
      files: [
        {
          path: 'pull-thing.py',
          name: 'pull-thing.py',
          content: 'def a():\n    pass\n',
          lines: [],
        },
        { path: 'thing.py', name: 'thing.py', content: 'def b():\n    pass\n', lines: [] },
      ],
      activeFile: 'thing.py',
      origins: { 'thing.py': { url: 'https://example.com/thing.py', pulledAt: at } },
    } as Partial<AppStore>);
    render(<TopBar />);

    expect(screen.queryByTestId('pull-origin-thing.py')).not.toBeNull();
    expect(screen.queryByTestId('pull-origin-pull-thing.py')).toBeNull();
    expect(screen.getAllByTestId('chip-pull-thing.py')).toHaveLength(1);
  });
});

describe('顶栏悬浮提示：来源动作（issue #7）', () => {
  const path = 'example.com/pkg/tool.py';
  const url = 'https://example.com/pkg/tool.py';
  const at = Date.UTC(2026, 9, 30, 1, 2, 3);
  const batch = { sourceUrl: url, ref: null, paths: [path], pulledAt: at };

  function presetPulled(): void {
    preset({
      files: [
        { path, name: 'tool.py', content: 'def f():\n    pass\n', lines: [] },
        { path: 'local.py', name: 'local.py', content: 'def g():\n    pass\n', lines: [] },
      ],
      activeFile: path,
      origins: { [path]: { url, pulledAt: at } },
      batches: [batch],
    } as Partial<AppStore>);
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('拉取文件的提示里有 Copy URL 与 Refresh from source；本地文件没有这两个动作', () => {
    presetPulled();
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    expect(screen.getByTestId('chip-tooltip-' + path).textContent).toContain('Pulled from ' + url);
    expect(screen.queryByTestId('pull-copy-' + path)).not.toBeNull();
    expect(screen.queryByTestId('pull-refresh-' + path)).not.toBeNull();

    fireEvent.mouseOver(screen.getByTestId('chip-local.py'));
    expect(screen.getByTestId('chip-tooltip-local.py').textContent).toContain('local.py');
    expect(screen.queryByTestId('pull-copy-local.py')).toBeNull();
    expect(screen.queryByTestId('pull-refresh-local.py')).toBeNull();
  });

  it('Copy URL 把来源 URL 写进剪贴板', () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    presetPulled();
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    fireEvent.click(screen.getByTestId('pull-copy-' + path));
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it('Refresh from source 调的是这一批的刷新（批次身份 = 来源 URL）', () => {
    const refreshed: string[] = [];
    preset({
      files: [{ path, name: 'tool.py', content: 'def f():\n    pass\n', lines: [] }],
      origins: { [path]: { url, pulledAt: at } },
      batches: [batch],
      refreshBatch: async (sourceUrl: string) => {
        refreshed.push(sourceUrl);
      },
    } as Partial<AppStore>);
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    fireEvent.click(screen.getByTestId('pull-refresh-' + path));
    expect(refreshed).toEqual([url]);
  });

  it('有来源但没有批次（旧快照）：URL 仍可复制，刷新按钮不出现', () => {
    preset({
      files: [{ path, name: 'tool.py', content: 'def f():\n    pass\n', lines: [] }],
      origins: { [path]: { url, pulledAt: at } },
      batches: [],
    } as Partial<AppStore>);
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    expect(screen.queryByTestId('pull-copy-' + path)).not.toBeNull();
    expect(screen.queryByTestId('pull-refresh-' + path)).toBeNull();
  });

  it('拉取进行中：刷新按钮禁用，点了也不会再发一轮', () => {
    const refreshed: string[] = [];
    preset({
      files: [{ path, name: 'tool.py', content: 'def f():\n    pass\n', lines: [] }],
      origins: { [path]: { url, pulledAt: at } },
      batches: [batch],
      pulling: true,
      refreshBatch: async (sourceUrl: string) => {
        refreshed.push(sourceUrl);
      },
    } as Partial<AppStore>);
    render(<TopBar />);
    fireEvent.mouseOver(screen.getByTestId('chip-' + path));
    fireEvent.click(screen.getByTestId('pull-refresh-' + path));
    expect(refreshed).toEqual([]);
    expect(screen.getByTestId('pull-refresh-' + path).textContent).toBe('Refreshing…');
  });
});

describe('勾选清单模态（issue #6）', () => {
  const listing: GithubListing = {
    sourceUrl: 'https://github.com/o/r/tree/main/pkg',
    owner: 'o',
    repo: 'r',
    ref: 'main',
    dir: 'pkg',
    entries: [
      { path: 'pkg/a.py', sessionPath: 'o/r/pkg/a.py', size: 120, selectable: true },
      { path: 'pkg/b.pyi', sessionPath: 'o/r/pkg/b.pyi', size: 2048, selectable: true },
      {
        path: 'pkg/huge.py',
        sessionPath: 'o/r/pkg/huge.py',
        size: MAX_FILE_SIZE + 1,
        selectable: false,
      },
    ],
  };

  function presetListing(): void {
    preset({ pullListing: listing });
  }

  it('清单为空时整块不渲染', () => {
    preset({ pullListing: null });
    render(<PullListingDialog />);
    expect(screen.queryByTestId('pull-listing-dialog')).toBeNull();
  });

  it('每项显示体积；超 1MB 的条目置灰不可选', () => {
    presetListing();
    render(<PullListingDialog />);

    expect(screen.getByTestId('pull-listing-row-pkg/a.py').textContent).toContain('120 B');
    expect(screen.getByTestId('pull-listing-row-pkg/b.pyi').textContent).toContain('2.0 KB');
    expect(screen.getByTestId('pull-listing-size-pkg/huge.py').textContent).toContain('over 1 MB');
    expect(
      (screen.getByTestId('pull-listing-check-pkg/huge.py') as HTMLInputElement).disabled
    ).toBe(true);
    expect((screen.getByTestId('pull-listing-check-pkg/a.py') as HTMLInputElement).disabled).toBe(
      false
    );
  });

  it('界面显示当前剩余配额，勾选数量以它封顶', () => {
    const files = Array.from({ length: MAX_FILES - 1 }, (_, i) => ({
      path: 'local/f' + i + '.py',
      name: 'f' + i + '.py',
      content: 'def f' + i + '():\n    pass\n',
      lines: [],
    }));
    preset({ files: files as AppStore['files'], pullListing: listing });
    render(<PullListingDialog />);

    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('1 of ' + MAX_FILES);
    // 唯一一个空位被 a.py 占掉之后，其余可选项全部禁用
    fireEvent.click(screen.getByTestId('pull-listing-check-pkg/a.py'));
    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('Selected 1');
    expect((screen.getByTestId('pull-listing-check-pkg/b.pyi') as HTMLInputElement).disabled).toBe(
      true
    );
    expect((screen.getByTestId('pull-listing-check-pkg/a.py') as HTMLInputElement).disabled).toBe(
      false
    );
  });

  it('关键字过滤只影响可见行，勾选集合跨过滤保留', () => {
    presetListing();
    render(<PullListingDialog />);

    fireEvent.click(screen.getByTestId('pull-listing-check-pkg/a.py'));
    fireEvent.change(screen.getByTestId('pull-listing-filter'), { target: { value: 'b.pyi' } });
    expect(screen.queryByTestId('pull-listing-row-pkg/a.py')).toBeNull();
    expect(screen.queryByTestId('pull-listing-row-pkg/b.pyi')).not.toBeNull();

    // 过滤后再全选：只加可见的那些，a.py 的勾选没被抹掉
    fireEvent.click(screen.getByTestId('pull-listing-select-all'));
    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('Selected 2');
    fireEvent.change(screen.getByTestId('pull-listing-filter'), { target: { value: '' } });
    expect((screen.getByTestId('pull-listing-check-pkg/a.py') as HTMLInputElement).checked).toBe(
      true
    );
    expect((screen.getByTestId('pull-listing-check-pkg/b.pyi') as HTMLInputElement).checked).toBe(
      true
    );

    fireEvent.click(screen.getByTestId('pull-listing-clear'));
    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('Selected 0');
  });

  it('过滤之后没有匹配项：给出空态文案', () => {
    presetListing();
    render(<PullListingDialog />);
    fireEvent.change(screen.getByTestId('pull-listing-filter'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('pull-listing-empty').textContent).toContain('match that filter');
  });

  it('确认把勾选的仓库相对路径交给 store，没勾选时按钮不可点', () => {
    const calls: string[][] = [];
    preset({
      pullListing: listing,
      confirmPullListing: async (selected: string[]) => {
        calls.push(selected);
      },
    } as Partial<AppStore>);
    render(<PullListingDialog />);

    expect((screen.getByTestId('pull-listing-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pull-listing-row-pkg/b.pyi'));
    expect((screen.getByTestId('pull-listing-check-pkg/b.pyi') as HTMLInputElement).checked).toBe(
      true
    );
    fireEvent.click(screen.getByTestId('pull-listing-confirm'));
    expect(calls).toEqual([['pkg/b.pyi']]);
  });

  it('拉取进行中：进度按「第 n 个 / 共 N 个」显示，按钮与关闭都禁用', () => {
    preset({ pullListing: listing, pulling: true, pullProgress: { done: 1, total: 3 } });
    render(<PullListingDialog />);

    expect(screen.getByTestId('pull-listing-progress').textContent).toBe('Pulling 1 / 3');
    expect((screen.getByTestId('pull-listing-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('pull-listing-cancel') as HTMLButtonElement).disabled).toBe(true);
  });

  it('取消只关清单，不发请求（dismissPullListing 是唯一动作）', () => {
    const dismissed: boolean[] = [];
    preset({
      pullListing: listing,
      dismissPullListing: () => {
        dismissed.push(true);
      },
    } as Partial<AppStore>);
    render(<PullListingDialog />);

    fireEvent.click(screen.getByTestId('pull-listing-cancel'));
    expect(dismissed).toEqual([true]);
  });

  it('确认后顶上来的是另一条清单（哪怕 URL 相同）：勾选与过滤词清零（issue #8 队列）', async () => {
    // 两条相同 URL 的清单排队时 sourceUrl 不变，但清单确实换了一茬 —— 换代判据是对象身份
    const next: GithubListing = { ...listing };
    preset({
      pullListing: listing,
      confirmPullListing: async () => {
        useAppStore.setState({ pullListing: next } as Partial<AppStore>);
      },
    } as Partial<AppStore>);
    render(<PullListingDialog />);

    fireEvent.click(screen.getByTestId('pull-listing-check-pkg/a.py'));
    fireEvent.change(screen.getByTestId('pull-listing-filter'), { target: { value: 'a.py' } });
    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('Selected 1');

    await act(async () => {
      fireEvent.click(screen.getByTestId('pull-listing-confirm'));
    });
    expect((screen.getByTestId('pull-listing-filter') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('pull-listing-quota').textContent).toContain('Selected 0');
  });
});

describe('顶栏：拉取的报错要说出来', () => {
  it('pullIssues 逐条出现在告警条里', () => {
    preset({
      files: [{ path: 'a.py', name: 'a.py', content: '', lines: [] }],
      pullIssues: ['http:// is blocked as mixed content by the browser — use the https:// version'],
    } as Partial<AppStore>);
    render(<TopBar />);
    expect(screen.getByTestId('topbar-pull-issues').textContent).toContain('mixed content');
    // 不并进解析告警那条：那句开头写死了「N file(s) had issues」，而这一条没有对应的文件
  });
});
