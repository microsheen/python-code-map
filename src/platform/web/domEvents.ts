/**
 * DOM 事件适配：滚轮缩放必须用非被动监听，否则 preventDefault 失效、页面会跟着滚。
 * 指针拖拽也在这里统一处理（RN 的 onPointerMove 只在指针位于组件内时触发）。
 */

export function asElement(ref: { current: unknown } | null | undefined): HTMLElement | null {
  const cur = ref?.current;
  if (!cur) return null;
  if (typeof HTMLElement !== 'undefined' && cur instanceof HTMLElement) return cur;
  // react-native-web 的组件实例上挂着可测量的 DOM 节点
  const maybe = cur as { ownerDocument?: unknown; addEventListener?: unknown };
  if (typeof maybe.addEventListener === 'function') return cur as HTMLElement;
  return null;
}

export interface WheelHandler {
  (e: WheelEvent): void;
}

export function subscribeWheel(el: HTMLElement | null, handler: WheelHandler): () => void {
  if (!el) return () => undefined;
  const wrapped = (e: WheelEvent): void => {
    e.preventDefault();
    handler(e);
  };
  el.addEventListener('wheel', wrapped, { passive: false });
  return () => el.removeEventListener('wheel', wrapped);
}

/** 原生 pointerdown 订阅（RN 的合成事件里拿不到 DOM PointerEvent）。 */
export function subscribePointerDown(
  el: HTMLElement | null,
  handler: (e: PointerEvent) => void,
): () => void {
  if (!el) return () => undefined;
  el.addEventListener('pointerdown', handler);
  return () => el.removeEventListener('pointerdown', handler);
}

export interface DragHandlers {
  onMove: (dx: number, dy: number, e: PointerEvent) => void;
  onEnd?: (e: PointerEvent) => void;
}

/** 从一次 pointerdown 开始，接管 window 上的 move/up，返回取消函数。 */
export function startPointerDrag(start: PointerEvent, handlers: DragHandlers): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const startX = start.clientX;
  const startY = start.clientY;
  const onMove = (e: PointerEvent): void => {
    handlers.onMove(e.clientX - startX, e.clientY - startY, e);
  };
  const onUp = (e: PointerEvent): void => {
    cleanup();
    handlers.onEnd?.(e);
  };
  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onCancel = (): void => cleanup();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  return cleanup;
}

/** 把 client 坐标换算成容器内坐标。 */
export function localPoint(el: HTMLElement | null, clientX: number, clientY: number): { x: number; y: number } {
  if (!el || typeof el.getBoundingClientRect !== 'function') return { x: clientX, y: clientY };
  const rect = el.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}