/**
 * IndexedDB 持久化层：保存/恢复/清除文件会话。
 * 所有操作异步、静默降级——失败时不影响主流程。
 */
import type { PickedFile } from '../../parser/types';

const DB_NAME = 'code-map';
const DB_VERSION = 1;
const STORE_NAME = 'session';
const KEY = 'current';

export interface SessionData {
  files: PickedFile[];
  activeFile: string | null;
  timestamp: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 保存当前会话（文件列表 + 活动文件）。 */
export async function saveSession(
  files: PickedFile[],
  activeFile: string | null,
): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(
        { files, activeFile, timestamp: Date.now() } satisfies SessionData,
        KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 静默降级：IndexedDB 不可用时不影响主流程
  }
}

/** 读取上次保存的会话；无数据或失败时返回 null。 */
export async function loadSession(): Promise<SessionData | null> {
  try {
    const db = await openDB();
    const result = await new Promise<SessionData | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

/** 清除会话数据。 */
export async function clearSession(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 静默降级
  }
}
