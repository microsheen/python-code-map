/**
 * 顶栏联盟推广位的开关行为：
 *  1. 空态（candidates 空或 href 为 null）整条不渲染 —— 还没批下来之前，页面必须和原来一模一样；
 *  2. 文案跟着链接走：候选数组里每项自带 href + text，抽中谁就用谁的文案，不能和全局 tag 分裂；
 *  3. 重渲染不换链接：随机只在挂载时抽一次；
 *  4. 这里只验 DOM 形状；「链接不能变成脚本/像素」那条由 audit:egress 守。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  pickPromo,
  promoTag,
  PROMO,
  PromoCandidate,
  PromoConfig,
  TopBar,
} from '../src/components/TopBar';
import { NO_SELECTION, useAppStore } from '../src/state/store';

let originalPromo: PromoConfig;

const resetStore = () =>
  useAppStore.setState({
    status: 'idle',
    files: [],
    graph: null,
    warnings: [],
    selection: NO_SELECTION,
  });

const emptyPromo: PromoConfig = { candidates: [], tag: 'Ad' };

beforeEach(() => {
  originalPromo = JSON.parse(JSON.stringify(PROMO)) as PromoConfig;
  act(() => {
    resetStore();
    // 覆盖到模块级 PROMO：TopBar 挂载时用 useState 初始值抽一次，
    // 所以必须在 render 之前就把值改掉
    Object.assign(PROMO, emptyPromo);
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    Object.assign(PROMO, originalPromo);
  });
});

// ---------- pickPromo / promoTag 纯函数 ----------

it('pickPromo 空数组 → null', () => {
  expect(pickPromo({ candidates: [], tag: 'Ad' })).toBeNull();
});

it('pickPromo href:null → null', () => {
  expect(pickPromo({ href: null })).toBeNull();
});

it('pickPromo 单条形态 → 返回完整候选', () => {
  const cfg: PromoConfig = { href: 'https://a.example', text: 'A', tag: 'Ad' };
  expect(pickPromo(cfg)).toEqual({ href: 'https://a.example', text: 'A' });
});

it('pickPromo 候选数组 → 返回数组中某一条', () => {
  const candidates: PromoCandidate[] = [
    { href: 'https://a.example', text: 'A' },
    { href: 'https://b.example', text: 'B' },
  ];
  const picks = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const got = pickPromo({ candidates, tag: 'Ad' });
    expect(got).not.toBeNull();
    picks.add(got!.href);
  }
  // 跑 50 次至少应该摸到两条，等概率随机才符合预期
  expect(picks.size).toBe(2);
});

it('promoTag 空态返回空串，非空返回顶层 tag', () => {
  expect(promoTag({ href: null })).toBe('');
  expect(promoTag({ candidates: [], tag: 'Ad' })).toBe('Ad');
  expect(promoTag({ href: 'x', text: 'y', tag: '推广' })).toBe('推广');
});

// ---------- 组件渲染 ----------

it('空态不渲染', () => {
  // candidates 已经是空数组，见 beforeEach
  render(<TopBar />);
  expect(screen.queryByTestId('topbar-promo')).toBeNull();
});

it('候选数组时：文案和链接成对出现，Ad 角标到位', () => {
  const cand = [
    { href: 'https://x.example/?a=1', text: 'X line.' },
    { href: 'https://y.example/?a=1', text: 'Y line.' },
  ];
  Object.assign(PROMO, { candidates: cand, tag: 'Ad' });

  // 让 pickPromo 每次返回确定性的第一条（mock Math.random）
  const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
  render(<TopBar />);
  spy.mockRestore();

  const link = screen.getByTestId('topbar-promo-link');
  expect(link.getAttribute('href')).toBe('https://x.example/?a=1');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('sponsored');
  expect(screen.getByTestId('topbar-promo').textContent).toContain('Ad');
  // 文案必须与抽到的那条匹配，不能是全局共享的旧文案
  expect(screen.getByTestId('topbar-promo').textContent).toContain('X line.');
  expect(screen.getByTestId('topbar-promo').textContent).not.toContain('Y line.');
});

it('候选数组时：重渲染不会换链接和文案', () => {
  const cand = [
    { href: 'https://x.example/?a=1', text: 'X line.' },
    { href: 'https://y.example/?a=1', text: 'Y line.' },
  ];
  Object.assign(PROMO, { candidates: cand, tag: 'Ad' });

  const spy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
  const { rerender } = render(<TopBar />);
  spy.mockRestore();

  const firstHref = screen.getByTestId('topbar-promo-link').getAttribute('href');
  const firstText = screen.getByTestId('topbar-promo-link').textContent;

  // store 更新会让顶栏重渲染：随机只在挂载时抽一次，链接和文案都不能跟着跳
  act(() => resetStore());
  rerender(<TopBar />);

  expect(screen.getByTestId('topbar-promo-link').getAttribute('href')).toBe(firstHref);
  expect(screen.getByTestId('topbar-promo-link').textContent).toBe(firstText);
});
