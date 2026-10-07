import { api, ApiError } from "./api.ts";
import type { Article } from "./api.ts";

export type OfflinePatch = Partial<Pick<Article, "state" | "favorite" | "progress" | "tags" | "title">>;
export interface PendingPatch {
  id: string;
  patch: OfflinePatch;
}
export interface QueueStorage {
  read(): Promise<PendingPatch[]>;
  write(items: PendingPatch[]): Promise<void>;
}

export function createOfflineQueue(storage: QueueStorage) {
  let tail: Promise<unknown> = Promise.resolve();
  let cleared = false;
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    clear: (remove: () => Promise<void>) => {
      cleared = true;
      return serial(remove);
    },
    enqueue: (id: string, patch: OfflinePatch) =>
      serial(async () => {
        if (cleared) return;
        const items = await storage.read();
        await storage.write([...items, { id, patch }]);
      }),
    replay: (send: (id: string, patch: OfflinePatch) => Promise<unknown>) =>
      serial(async () => {
        if (cleared) return;
        const items = await storage.read();
        while (items.length && !cleared) {
          const item = items[0]!;
          await send(item.id, item.patch);
          if (cleared) return;
          items.shift();
          await storage.write([...items]);
        }
      }),
  };
}

let owner: string | null = null;
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open("later-offline", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("data");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}
async function read<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("data").objectStore("data").get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
async function write(key: string, value: unknown): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("data", "readwrite");
    tx.objectStore("data").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage was interrupted"));
  });
}
const queues = new Map<string, ReturnType<typeof createOfflineQueue>>();
function queue(userId: string) {
  let value = queues.get(userId);
  if (!value) {
    value = createOfflineQueue({
      read: async () => (await read<PendingPatch[]>(`${userId}:queue`)) ?? [],
      write: (items) => write(`${userId}:queue`, items),
    });
    queues.set(userId, value);
  }
  return value;
}
export async function clearOffline(userId: string): Promise<void> {
  if (owner === userId) owner = null;
  const pending = queues.get(userId);
  const remove = async () => {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("data", "readwrite");
      const data = tx.objectStore("data");
      data.delete(`${userId}:articles`);
      data.delete(`${userId}:queue`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Offline storage was interrupted"));
    });
    queues.delete(userId);
  };
  await (pending ? pending.clear(remove) : remove());
}
export async function clearOtherOfflineUsers(userId: string): Promise<void> {
  const database = await db();
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = database.transaction("data").objectStore("data").getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const users = new Set(queues.keys());
  if (owner) users.add(owner);
  for (const key of keys) {
    if (typeof key === "string" && /:(articles|queue)$/.test(key))
      users.add(key.replace(/:(articles|queue)$/, ""));
  }
  await Promise.all([...users].filter((id) => id !== userId).map(clearOffline));
}
export function setOfflineUser(userId: string | null): void {
  owner = userId;
}
export async function listOffline(): Promise<Article[]> {
  if (!owner) return [];
  const userId = owner;
  const articles = (await read<Article[]>(`${userId}:articles`)) ?? [];
  const pending = (await read<PendingPatch[]>(`${userId}:queue`)) ?? [];
  return articles.map((article) =>
    pending.filter((p) => p.id === article.id).reduce((value, p) => ({ ...value, ...p.patch }), article),
  );
}
export async function getOfflineArticle(id: string): Promise<Article | undefined> {
  return (await listOffline()).find((article) => article.id === id);
}
export async function queuePatch(id: string, patch: OfflinePatch): Promise<void> {
  if (!owner) throw new Error("Sign in before saving offline changes");
  await queue(owner).enqueue(id, patch);
}
export async function replayOffline(): Promise<void> {
  const userId = owner;
  if (!userId) return;
  await queue(userId).replay(async (id, patch) => {
    if (owner !== userId) throw new Error("Account changed");
    try {
      const updated = await api.update(id, patch);
      const articles = (await read<Article[]>(`${userId}:articles`)) ?? [];
      if (owner !== userId) return;
      await write(
        `${userId}:articles`,
        articles.map((article) => (article.id === id ? updated : article)),
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  });
}
export async function cacheInbox(): Promise<void> {
  const userId = owner;
  if (!userId || !navigator.onLine) return;
  await replayOffline();
  const { items } = await api.list({ state: "inbox", limit: 50 });
  const previous = (await read<Article[]>(`${userId}:articles`)) ?? [];
  const articles = await Promise.all(
    items.map(async (item) => {
      try {
        return await api.get(item.id);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
        return previous.find((a) => a.id === item.id) ?? item;
      }
    }),
  );
  if (owner === userId) await write(`${userId}:articles`, articles);
}
export async function updateOffline(id: string, patch: OfflinePatch): Promise<Article | undefined> {
  // Always persist first so a failed request cannot lose the user's changes.
  await queuePatch(id, patch);
  if (navigator.onLine) await replayOffline();
  return getOfflineArticle(id);
}
