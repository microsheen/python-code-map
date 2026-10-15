/**
 * 唯一路由：渲染应用根组件。
 */
import type { ReactNode } from 'react';
import { AppRoot } from '../src/components/AppRoot';

export default function Index(): ReactNode {
  return <AppRoot />;
}
