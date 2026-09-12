/**
 * expo-router 根布局：单页应用，不需要原生导航头（工具栏由 TopBar 自己画）。
 */
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';

export default function RootLayout(): ReactNode {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'none',
        contentStyle: { backgroundColor: '#0d1117' },
      }}
    />
  );
}
