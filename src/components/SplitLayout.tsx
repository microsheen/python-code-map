/**
 * 左右分栏 + 可拖拽分隔条。
 *
 * 左：代码（CodePane）  右：调用图（GraphPane）
 * 窗口宽度 < STACK_BELOW 时改为上下堆叠（分隔条拖拽改的是高度比例）。
 *
 * 拖拽同样走原生 pointerdown + window 级 move/up（见 domEvents），
 * 因为 RN 的 onPointerMove 只在指针停留在组件内部时才触发，快速拖动会丢事件。
 */
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { DimensionValue, LayoutChangeEvent, ViewStyle } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { asElement, startPointerDrag, subscribePointerDown } from '../platform/web/domEvents';
import type { ViewElement } from './viewRef';
import { useAppStore } from '../state/store';
import { colors } from '../theme';
import { CodePane } from './CodePane';
import { GraphPane } from './GraphPane';

/** 窄于这个宽度就上下堆叠 */
export const STACK_BELOW = 900;
/** 分隔条厚度 */
export const DIVIDER_SIZE = 6;

const COL_RESIZE = { cursor: 'col-resize' } as unknown as ViewStyle;
const ROW_RESIZE = { cursor: 'row-resize' } as unknown as ViewStyle;
const NO_TOUCH = { touchAction: 'none' } as unknown as ViewStyle;

export function SplitLayout(): ReactNode {
  const splitRatio = useAppStore((s) => s.splitRatio);
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const win = useWindowDimensions();
  const stacked = win.width > 0 && win.width < STACK_BELOW;

  const wrapRef = useRef<ViewElement | null>(null);
  const dividerRef = useRef<ViewElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  const stackedRef = useRef(stacked);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);
  useEffect(() => {
    stackedRef.current = stacked;
  }, [stacked]);

  const onWrapLayout = (e: LayoutChangeEvent): void => {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 && height <= 0) return;
    setSize((prev) =>
      Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1
        ? prev
        : { w: width, h: height },
    );
  };

  useEffect(() => {
    const el = asElement(dividerRef);
    return subscribePointerDown(el, (e) => {
      e.preventDefault();
      const startRatio = useAppStore.getState().splitRatio;
      startPointerDrag(e, {
        onMove: (dx, dy) => {
          const s = sizeRef.current;
          const total = stackedRef.current ? s.h : s.w;
          if (total <= 0) return;
          const delta = stackedRef.current ? dy : dx;
          setSplitRatio(startRatio + delta / total);
        },
      });
    });
    // setSplitRatio 是 zustand action，引用恒定
  }, [setSplitRatio]);

  // DimensionValue 只接受 `${number}%`，普通 string 不行，所以显式标注
  const pct: DimensionValue = `${splitRatio * 100}%`;
  const firstStyle: ViewStyle = stacked ? { height: pct } : { width: pct };
  const secondStyle: ViewStyle = { flex: 1 };

  return (
    <View
      ref={wrapRef}
      style={[styles.wrap, stacked && styles.wrapStacked]}
      onLayout={onWrapLayout}
      testID="split-layout"
    >
      <View style={[styles.pane, firstStyle]} testID="split-left">
        <CodePane />
      </View>
      <View
        ref={dividerRef}
        style={[styles.divider, stacked ? styles.dividerH : styles.dividerV, stacked ? ROW_RESIZE : COL_RESIZE, NO_TOUCH]}
        testID="split-divider"
      />
      <View style={[styles.pane, secondStyle]} testID="split-right">
        <GraphPane />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg, overflow: 'hidden' },
  wrapStacked: { flexDirection: 'column' },
  pane: { overflow: 'hidden' },
  divider: { backgroundColor: colors.border, flexShrink: 0 },
  dividerV: { width: DIVIDER_SIZE },
  dividerH: { height: DIVIDER_SIZE, width: '100%' },
});
