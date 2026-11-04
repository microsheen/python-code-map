/**
 * 顶栏联盟推广位的开关行为：
 *  1. href 为 null 时整条不渲染 —— 还没批下来之前，页面必须和原来一模一样；
 *  2. 填了 href 就是一个普通文字链接：新窗口打开、rel 带 sponsored、旁边有 Ad 角标；
 *  3. 这里只验 DOM 形状；「链接不能变成脚本/像素」那条由 audit:egress 守。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { PROMO, TopBar } from '../src/components/TopBar';
import { NO_SELECTION, useAppStore } from '../src/state/store';

beforeEach(() => {
  act(() => {
    useAppStore.setState({
      status: 'idle',
      files: [],
      graph: null,
      warnings: [],
      selection: NO_SELECTION,
    });
    PROMO.href = null;
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    PROMO.href = null;
  });
});

it('href 为 null 时整条不渲染', () => {
  render(<TopBar />);
  expect(screen.queryByTestId('topbar-promo')).toBeNull();
});

it('填了 href 后是可点的文字链接，并带 Ad 角标', () => {
  act(() => {
    PROMO.href = 'https://example.com/?ref=code-map';
  });
  render(<TopBar />);

  const link = screen.getByTestId('topbar-promo-link');
  expect(link.getAttribute('href')).toBe(PROMO.href);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('sponsored');
  expect(screen.getByTestId('topbar-promo').textContent).toContain('Ad');
});
