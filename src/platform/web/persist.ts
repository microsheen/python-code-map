/**
 * IndexedDB 持久化层：保存/恢复/清除文件会话。
 * 所有操作异步、静默降级——失败时不影响主流程。
 */
import type { PickedFile } from '../../parser/types';
import type { OriginMap, PullBatch } from '../../pull/batch';

const DB_NAME = 'code-map';
const DB_VERSION = 1;
const STORE_NAME = 'session';
const KEY = 'current';

export interface SessionData {
  files: PickedFile[];
  activeFile: string | null;
  timestamp: number;
  /**
   * 拉取文件的来源与批次元数据。两个都是**可选**字段：本功能之前存的快照没有它们，
   * 读出来是 undefined，一律当本地文件处理，读入不报错（issue #2「快照兼容」）。
   */
  origins?: OriginMap;
  batches?: PullBatch[];
}

/** saveSession 的第三个参数：随文件一起留存的拉取元数据。 */
export interface SessionMeta {
  origins?: OriginMap;
  batches?: PullBatch[];
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
  meta?: SessionMeta
): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(
        {
          files,
          activeFile,
          timestamp: Date.now(),
          origins: meta?.origins ?? {},
          batches: meta?.batches ?? [],
        } satisfies SessionData,
        KEY
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

/**
 * 只问「有没有存过会话」，不读内容：诊断块里的 persisted 是一个是/否，不是任何用户数据。
 * 用 getKey 而不是 get —— payload 根本不进这条路径。复用 loadSession 的同一个开库路径。
 * 任何异常一律 resolve(false)：面板是只读入口，绝不能把 reject 抛给它。
 */
export async function hasSession(): Promise<boolean> {
  try {
    const db = await openDB();
    const exists = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getKey(KEY);
      req.onsuccess = () => resolve(req.result !== undefined && req.result !== null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return exists;
  } catch {
    return false;
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
