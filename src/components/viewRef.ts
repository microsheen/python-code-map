/**
 * react-native 0.87 把 View 的类型写成了函数组件签名（(props) => ReactNode），
 * 所以 useRef<View> 拿到的是"组件类型"而不是"实例类型"，直接交给 ref 会报 TS2322。
 * 用 ComponentRef<typeof View> 取出真正的实例类型，两个组件共用这一处定义。
 */
import type { ComponentRef } from 'react';
import type { View } from 'react-native';

export type ViewElement = ComponentRef<typeof View>;
