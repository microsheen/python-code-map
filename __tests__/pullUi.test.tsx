/**
 * 拉取的 UI 接缝（issue #4）：空态面板的粘贴入口、文件标签上的来源标识、顶栏的报错条。
 *
 * 断言只看用户能看见/能读到的东西：按钮在不在、粘贴之后 store 收到了什么、标签上读不读得到
 * 来源 URL 与拉取时刻。样式与布局不进断言（那是冒烟截图的活）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadPanel } from '../src/components/UploadPanel';
import { TopBar } from '../src/components/TopBar';
import { useAppStore } from '../src/state/store';
import type { AppStore } from '../src/state/store';

const INITIAL = useAppStore.getState();

function preset(extra: Partial<AppStore>): void {
  useAppStore.setState({ ...INITIAL, ...extra }, true);
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ ...INITIAL }, true);
});

/** 把 pullFromText 换成可断言的假实现，返回它收到的调用。 */
function stubPull(impl?: (text: string) => Promise<void>): { calls: string[] } {
  const calls: string[] = [];
  preset({
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

  it('点开之前没有粘贴框，点开之后有 —— 而且这时候还没发任何东西', () => {
    const pull = stubPull();
    render(<UploadPanel />);
    expect(screen.queryByTestId('pull-input')).toBeNull();
    fireEvent.click(screen.getByTestId('upload-pull'));
    expect(screen.queryByTestId('pull-input')).not.toBeNull();
    expect(screen.queryByTestId('pull-submit')).not.toBeNull();
    expect(pull.calls).toEqual([]);
  });

  it('粘贴多行再确认：store 收到的就是那段原文（多行 = 多个批次，切分是 store 的事）', () => {
    const pull = stubPull();
    render(<UploadPanel />);
    fireEvent.click(screen.getByTestId('upload-pull'));
    const text = 'https://one.example.com/a.py\nhttps://two.example.com/b.py';
    fireEvent.change(screen.getByTestId('pull-input'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('pull-submit'));
    expect(pull.calls).toEqual([text]);
  });

  it('空粘贴点确认：不触发拉取（连一句提示都不必发请求）', () => {
    const pull = stubPull();
    render(<UploadPanel />);
    fireEvent.click(screen.getByTestId('upload-pull'));
    fireEvent.change(screen.getByTestId('pull-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pull-submit'));
    expect(pull.calls).toEqual([]);
  });

  it('拉取进行中：确认按钮禁用，免得连点发出重复请求', () => {
    const pull = stubPull();
    preset({ pulling: true } as Partial<AppStore>);
    render(<UploadPanel />);
    fireEvent.click(screen.getByTestId('upload-pull'));
    fireEvent.change(screen.getByTestId('pull-input'), {
      target: { value: 'https://one.example.com/a.py' },
    });
    fireEvent.click(screen.getByTestId('pull-submit'));
    expect(pull.calls).toEqual([]);
  });

  it('取消按钮把粘贴框收起来，不发请求', () => {
    const pull = stubPull();
    render(<UploadPanel />);
    fireEvent.click(screen.getByTestId('upload-pull'));
    fireEvent.click(screen.getByTestId('pull-cancel'));
    expect(screen.queryByTestId('pull-input')).toBeNull();
    expect(pull.calls).toEqual([]);
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
