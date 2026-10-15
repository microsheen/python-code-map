/**
 * 顶栏主题选择器的组件行为。
 *
 * 这里验的是「用户怎么用它」，色值本身在 theme.test.ts：
 *  1. 入口常驻且不受 busy 门控 —— 解析中、从 IndexedDB 恢复旧会话时正是盯着界面看的时候；
 *  2. 面板一开就是六行，每行三个预览色块 + 官方名 + 当前项打勾；
 *     预览块必须是**字面 hex**（THEMES[id]），因为 --cm-* 只描述当前主题，画不出别的主题；
 *  3. 点一行就落地：store 状态、<html> 上的变量、localStorage 三处同时到位，面板关掉；
 *  4. Escape 与「点面板外」都能关；
 *  5. 反向不变量：切主题不碰 AppStore —— 状态对象还是同一个引用，所以既不重渲染也不重新解析。
 *
 * 用 @testing-library/react 的 fireEvent（理由同 appFlow.test.tsx 头注：RNW 下 .press 会撞
 * "Text strings must be rendered within a <Text>" 不变量）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopBar } from '../src/components/TopBar';
import { DEFAULT_THEME, THEMES, THEME_ORDER } from '../src/theme';
import { THEME_PREF_KEY } from '../src/platform/web/themeVars';
import { NO_SELECTION, useAppStore } from '../src/state/store';
import { useThemeStore } from '../src/state/themeStore';

const disabledMarker = (el: HTMLElement) =>
  el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');

const testIdsInOrder = () =>
  Array.from(document.querySelectorAll('[data-testid]'))
    .map((el) => String(el.getAttribute('data-testid')))
    .filter((t) =>
      ['topbar-upload', 'topbar-scope', 'topbar-theme', 'topbar-feedback', 'topbar-reset'].includes(
        t
      )
    );

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  act(() => {
    useAppStore.setState({
      status: 'idle',
      files: [],
      graph: null,
      warnings: [],
      selection: NO_SELECTION,
    });
    // 直接 setState 而不是 setTheme：复位状态位，但不留偏好、不写变量
    useThemeStore.setState({ themeId: DEFAULT_THEME });
  });
});

afterEach(() => {
  cleanup();
  act(() => useThemeStore.setState({ themeId: DEFAULT_THEME }));
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

/** jsdom 把内联 background-color 归一成 rgb(...)，比对前先换算 */
const toRgbString = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
};

const openPanel = () => {
  fireEvent.click(screen.getByTestId('topbar-theme'));
  return screen.getByTestId('theme-panel');
};

describe('Theme 入口', () => {
  it('常驻顶栏：排在 scope 之后、Feedback 之前，Clear 出现/消失都不让它跳位', () => {
    render(<TopBar />);
    expect(testIdsInOrder()).toEqual([
      'topbar-upload',
      'topbar-scope',
      'topbar-theme',
      'topbar-feedback',
    ]);
    act(() => {
      useAppStore.setState({ status: 'ready', files: [{ path: 'a.py' } as never] });
    });
    expect(testIdsInOrder()).toEqual([
      'topbar-upload',
      'topbar-scope',
      'topbar-theme',
      'topbar-feedback',
      'topbar-reset',
    ]);
  });

  it('解析中（busy）也点得动：和 Feedback 同一个理由，故意不 gate', () => {
    act(() => useAppStore.setState({ status: 'parsing' }));
    render(<TopBar />);
    expect(disabledMarker(screen.getByTestId('topbar-upload') as HTMLElement)).toBe(true);
    expect(disabledMarker(screen.getByTestId('topbar-theme') as HTMLElement)).toBe(false);
    expect(openPanel()).toBeTruthy();
  });

  it('默认是关着的：不点就没有面板，也就没有多余的 window 监听', () => {
    render(<TopBar />);
    expect(screen.queryByTestId('theme-panel')).toBeNull();
  });
});

describe('主题面板', () => {
  it('六行齐、顺序按 THEME_ORDER，每行三个预览块 + 官方名，当前项打勾', () => {
    render(<TopBar />);
    const panel = openPanel();
    const rows = THEME_ORDER.map((id) => screen.getByTestId('theme-option-' + id));
    expect(rows.length).toBe(6);
    expect(rows.every((r) => panel.contains(r))).toBe(true);
    THEME_ORDER.forEach((id, i) => {
      const row = rows[i] as HTMLElement;
      const palette = THEMES[id];
      expect(row.textContent).toContain(palette.label);
      const current = id === DEFAULT_THEME;
      expect(row.getAttribute('aria-label')).toBe(
        current ? palette.label + ' (current)' : palette.label
      );
      expect(row.textContent.includes('\u2713')).toBe(current);
      const swatches = row.firstElementChild;
      expect(swatches?.children.length).toBe(3);
      // 预览必须是调色板里的字面色：写 var(--cm-*) 的话六行会长得一模一样（浏览器把 hex 归一成 rgb）
      const css = Array.from(swatches?.children ?? [])
        .map((el) => el.getAttribute('style') ?? '')
        .join('');
      expect(css).not.toContain('var(');
      for (const hex of [palette.colors.bg, palette.colors.accent, palette.colors.selected]) {
        expect(css).toContain(toRgbString(hex));
      }
    });
  });

  it('点 nord：store、<html> 变量、localStorage 同时到位，面板关掉', () => {
    render(<TopBar />);
    openPanel();
    fireEvent.click(screen.getByTestId('theme-option-nord'));
    expect(useThemeStore.getState().themeId).toBe('nord');
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe(THEMES.nord.colors.bg);
    expect(document.documentElement.style.getPropertyValue('--cm-tok-keyword')).toBe(
      THEMES.nord.tokenColors.keyword
    );
    expect(screen.queryByTestId('theme-panel')).toBeNull();
  });

  it('重开面板：勾跟着挪到 nord 那一行', () => {
    render(<TopBar />);
    openPanel();
    fireEvent.click(screen.getByTestId('theme-option-nord'));
    const panel = openPanel();
    expect(panel).toBeTruthy();
    expect(screen.getByTestId('theme-option-nord').getAttribute('aria-label')).toBe(
      'Nord (current)'
    );
    expect(screen.getByTestId('theme-option-nord').textContent).toContain('\u2713');
    expect(screen.getByTestId('theme-option-github-dark').getAttribute('aria-label')).toBe(
      'GitHub Dark'
    );
    expect(screen.getByTestId('theme-option-github-dark').textContent).not.toContain('\u2713');
  });

  it('Escape 关面板；点面板外也关；再点一次 Theme 也关', () => {
    render(<TopBar />);
    openPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('theme-panel')).toBeNull();

    openPanel();
    fireEvent.click(document.body);
    expect(screen.queryByTestId('theme-panel')).toBeNull();

    openPanel();
    fireEvent.click(screen.getByTestId('topbar-theme'));
    expect(screen.queryByTestId('theme-panel')).toBeNull();
  });

  it('包含判断：落在面板内的 click 不算「点外面」，别把刚打开的面板关掉', () => {
    render(<TopBar />);
    const panel = openPanel();
    fireEvent.click(panel);
    expect(screen.getByTestId('theme-panel')).toBeTruthy();
    // 面板里的六行都带 onPress —— 点它 = 切主题 + 关面板（这是正确语义，上面另有测试）。
    // 这里要验的是「包含」而非「面板自身」：真实点击常常落在行内某个非交互节点上
    // （预览色块、标签文本），它同样会冒泡到 window，必须被认成面板内部。
    const inner = document.createElement('div');
    panel.appendChild(inner);
    fireEvent.click(inner);
    expect(screen.getByTestId('theme-panel')).toBeTruthy();
    fireEvent.click(document.body);
    expect(screen.queryByTestId('theme-panel')).toBeNull();
  });

  it('切主题不碰 AppStore：状态对象还是同一个引用（不重渲染，也就不重新解析）', () => {
    render(<TopBar />);
    const before = useAppStore.getState();
    openPanel();
    fireEvent.click(screen.getByTestId('theme-option-dracula'));
    expect(useAppStore.getState()).toBe(before);
    expect(localStorage.getItem(THEME_PREF_KEY)).toBe('dracula');
  });

  it('刷新等于整套流程重跑：store 的初值来自 localStorage，首帧不用先闪默认深色', () => {
    localStorage.setItem(THEME_PREF_KEY, 'nord');
    jest.resetModules();
    // 重新 require = 重新走一遍模块图，等价于按 F5：themeStore 在加载时自己读偏好
    // 用块级 disable 而不是 disable-next-line：printWidth 会把长 require 折行，
    // next-line 就会指到注释或空行上，变成「无用的 disable + 一条真违规」。
    /* eslint-disable @typescript-eslint/no-require-imports */
    const booted =
      require('../src/platform/web/themeVars') as typeof import('../src/platform/web/themeVars');
    const fresh = require('../src/state/themeStore') as typeof import('../src/state/themeStore');
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(booted.initTheme()).toBe('nord');
    expect(fresh.useThemeStore.getState().themeId).toBe('nord');
    expect(document.documentElement.style.getPropertyValue('--cm-bg')).toBe(THEMES.nord.colors.bg);
  });
});
