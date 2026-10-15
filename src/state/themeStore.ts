/**
 * 主题偏好：一个独立的小 store。
 *
 * 为什么不塞进 AppStore：AppStore 的 reset() 是「清掉我在看的代码」（Clear 按钮、
 * 会话恢复失败都会走它）。偏好和被分析的代码不是一回事 —— 混在一起的话，一次 Clear
 * 就把用户选了好几天的主题打回默认。分开存放，reset 碰不到它。
 *
 * 切换主题本身不重渲染界面（颜色是 <html> 上的 CSS 变量）。这个 store 存在的理由
 * 只有一个：让顶栏面板知道该在哪一行画勾。
 */
import { create } from 'zustand';
import type { ThemeId } from '../theme';
import {
  applyPalette,
  readThemePref,
  setThemeColorMeta,
  writeThemePref,
} from '../platform/web/themeVars';

export interface ThemeState {
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  // 与 initTheme() 读同一个键，因此模块加载顺序不影响最终状态：谁先跑都是这个值
  themeId: readThemePref(),
  setTheme: (id) => {
    writeThemePref(id);
    applyPalette(id);
    setThemeColorMeta(id);
    set({ themeId: id });
  },
}));
