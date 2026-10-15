/**
 * 唯一的 DOM 触点之一：文件选择 / 拖拽上传。
 * 对外只暴露 pickFiles / readFiles / subscribeDrop，业务层不感知 DOM。
 */
import type { PickedFile } from '../../parser/types';

export const PY_EXT_RE = /\.(py|pyi)$/i;

export function isWeb(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

type WebKitFile = File & { webkitRelativePath?: string };

/** 读取 FileList；非 .py/.pyi 的条目直接忽略，读取失败的条目标 error 而不是整体失败。 */
export async function readFiles(list: FileList | File[] | null | undefined): Promise<PickedFile[]> {
  if (!list) return [];
  const arr = Array.from(list as ArrayLike<File>);
  const out: PickedFile[] = [];
  for (const f of arr) {
    const rel = (f as WebKitFile).webkitRelativePath || f.name || '';
    const path = normalizeSlashes(rel);
    if (!PY_EXT_RE.test(path)) continue;
    try {
      const content = await f.text();
      out.push({ path, name: f.name, content });
    } catch (e) {
      out.push({
        path,
        name: f.name,
        content: '',
        error: `读取失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

/** 打开系统文件选择框（多选）。用户取消时返回 []。 */
export function pickFiles(): Promise<PickedFile[]> {
  if (!isWeb()) return Promise.resolve([]);
  return new Promise<PickedFile[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.py,.pyi,text/x-python';
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';

    let settled = false;
    const finish = (files: PickedFile[]): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(files);
    };
    // 用户点"取消"时不会触发 change，用 focus 回来兜底
    const onFocus = (): void => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish([]);
      }, 500);
    };

    input.addEventListener('change', () => {
      void readFiles(input.files).then(finish);
    });
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

export interface DropSubscription {
  unsubscribe: () => void;
}

/**
 * 在 window 上监听拖拽。onDragging 用于高亮投放区。
 * 只处理带 Files 的拖拽，页面内拖动文本不受影响。
 */
export function subscribeDrop(
  onFiles: (files: PickedFile[]) => void,
  onDragging?: (dragging: boolean) => void,
): DropSubscription {
  if (!isWeb()) return { unsubscribe: () => undefined };
  let depth = 0;

  const hasFiles = (e: DragEvent): boolean => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    return Array.from(dt.types ?? []).includes('Files');
  };

  const setDragging = (v: boolean): void => {
    onDragging?.(v);
  };

  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    if (depth === 1) setDragging(true);
  };
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setDragging(false);
    void readFiles(e.dataTransfer?.files).then((files) => {
      if (files.length > 0) onFiles(files);
    });
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  return {
    unsubscribe: () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}