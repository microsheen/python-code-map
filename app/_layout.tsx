/**
 * expo-router 根布局：单页应用，不需要原生导航头（工具栏由 TopBar 自己画）。
 *
 * initTheme() 写在模块作用域而不是 useEffect 里：CSP 的 script-src 只有 'self'，
 * 没有内联 boot script 可用，所以把「装载主题」提前到入口模块执行的第一件事，
 * 一定早于第一次绘制 —— 存过非默认主题的用户不会先看到一帧深色。
 */
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { initTheme } from '../src/platform/web/themeVars';
import { colors } from '../src/theme';

initTheme();

export default function RootLayout(): ReactNode {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'none',
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
