/**
 * 在图上"点某个节点"的测试辅助。
 *
 * 产品实现早就不是给每个 <G> 挂 onPress 了：容器监听原生 pointerdown，抬起时若没超过
 * 拖动阈值，就用 GraphPane 的 hitTestNode 做几何命中（src/components/GraphPane/index.tsx）。
 * 所以测试也必须走同一条真实事件路径 —— 把节点中心按当前 view 换算成容器坐标，
 * 依次向容器发 pointerdown、向 window 发 pointerup（pointerup 是 startPointerDrag 接管的地方）。
 * 直接的 fireEvent.click(getByTestId('graph-node-…')) 命中不了任何东西：打桩后的 svg
 * 丢掉了全部几何属性，节点在 jsdom 里没有尺寸。
 */
import { act, screen } from '@testing-library/react';
import { layoutGraph } from '../../src/graph/layout';
import { applyScope } from '../../src/graph/scope';
import type { FuncId } from '../../src/parser/types';
import { useAppStore } from '../../src/state/store';

function canvas(): HTMLElement {
  const el = screen.getByTestId('graph-canvas');
  if (!(el instanceof HTMLElement)) throw new Error('graph-canvas 不是 DOM 元素');
  return el;
}

/** 节点中心对应的 client 坐标（与 domEvents.localPoint 的口径一致，减去容器 rect 原点）。 */
export function nodeClientPoint(funcId: FuncId): { x: number; y: number } {
  const st = useAppStore.getState();
  if (!st.graph) throw new Error('store 里没有图，无法点击节点');
  const el = canvas();
  const rect = el.getBoundingClientRect();
  const box = layoutGraph(applyScope(st.graph, st.scope)).nodes.get(funcId);
  if (!box) throw new Error(`节点 ${funcId} 不在当前范围内`);
  return {
    x: rect.left + st.view.tx + box.cx * st.view.scale,
    y: rect.top + st.view.ty + box.cy * st.view.scale,
  };
}

/** 按下并抬起同一个点：等价于用户的一次点击。 */
export function tapPoint(x: number, y: number): void {
  const el = canvas();
  act(() => {
    el.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
    );
  });
}

/** 点击图里的节点：走 pointerdown + 几何 hit-test，与真浏览器行为一致。 */
export function tapGraphNode(funcId: FuncId): void {
  const p = nodeClientPoint(funcId);
  tapPoint(p.x, p.y);
}

/**
 * 按住拖动超过 DRAG_SLOP：应当只平移视图，不选中任何节点。
 * 返回拖动后的位移，方便调用方断言。
 */
export function dragGraph(from: { x: number; y: number }, dx: number, dy: number): void {
  const el = canvas();
  act(() => {
    el.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y })
    );
    window.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, cancelable: true, button: 0, clientX: from.x + dx, clientY: from.y + dy })
    );
    window.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: from.x + dx, clientY: from.y + dy })
    );
  });
}
