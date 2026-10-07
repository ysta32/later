import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflineQueue } from "./offline.ts";
import type { PendingPatch, QueueStorage } from "./offline.ts";
function memory(initial: PendingPatch[] = []): QueueStorage {
  let items = structuredClone(initial);
  return {
    read: async () => structuredClone(items),
    write: async (next) => {
      items = structuredClone(next);
    },
  };
}
describe("offline mutation queue", () => {
  it("persists concurrent state and progress updates in order", async () => {
    const storage = memory();
    const queue = createOfflineQueue(storage);
    await Promise.all([
      queue.enqueue("a", { progress: 0.3 }),
      queue.enqueue("a", { state: "archived" }),
      queue.enqueue("b", { favorite: true }),
    ]);
    const sent: PendingPatch[] = [];
    await queue.replay(async (id, patch) => {
      sent.push({ id, patch });
    });
    expect(sent).toEqual([
      { id: "a", patch: { progress: 0.3 } },
      { id: "a", patch: { state: "archived" } },
      { id: "b", patch: { favorite: true } },
    ]);
    expect(await storage.read()).toEqual([]);
  });
  it("removes only acknowledged patches and retries a failure after reload", async () => {
    const storage = memory([
      { id: "a", patch: { progress: 0.5 } },
      { id: "b", patch: { state: "archived" } },
    ]);
    const queue = createOfflineQueue(storage);
    await expect(
      queue.replay(async (id) => {
        if (id === "b") throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(await storage.read()).toEqual([{ id: "b", patch: { state: "archived" } }]);
    await createOfflineQueue(storage).replay(async () => undefined);
    expect(await storage.read()).toEqual([]);
  });
  it("does not lose writes arriving during replay or duplicate simultaneous replays", async () => {
    const storage = memory([{ id: "a", patch: { progress: 0.2 } }]);
    const queue = createOfflineQueue(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const replay = queue.replay(async (id) => {
      sent.push(id);
      await gate;
    });
    const enqueue = queue.enqueue("b", { progress: 0.8 });
    release();
    await Promise.all([replay, enqueue]);
    await Promise.all([
      queue.replay(async (id) => {
        sent.push(id);
      }),
      queue.replay(async (id) => {
        sent.push(id);
      }),
    ]);
    expect(sent).toEqual(["a", "b"]);
    expect(await storage.read()).toEqual([]);
  });
  it("waits for an in-flight replay before clearing and stops remaining sends", async () => {
    const storage = memory([
      { id: "a", patch: {} },
      { id: "b", patch: {} },
    ]);
    const queue = createOfflineQueue(storage);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sent: string[] = [];
    const replay = queue.replay(async (id) => {
      sent.push(id);
      started();
      await gate;
    });
    await sending;
    const clear = queue.clear(() => storage.write([]));
    release();
    await Promise.all([replay, clear]);
    await queue.enqueue("c", {});
    expect(sent).toEqual(["a"]);
    expect(await storage.read()).toEqual([]);
  });

  it("surfaces persistence failures and recovers for later operations", async () => {
    const storage = memory();
    let fail = true;
    const queue = createOfflineQueue({
      read: storage.read,
      write: async (items) => {
        if (fail) throw new Error("quota exceeded");
        await storage.write(items);
      },
    });
    await expect(queue.enqueue("a", { progress: 0.5 })).rejects.toThrow("quota exceeded");
    fail = false;
    await queue.enqueue("b", { progress: 0.6 });
    expect(await storage.read()).toEqual([{ id: "b", patch: { progress: 0.6 } }]);
  });
});

describe("offline account cleanup", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    vi.resetModules();
    const values = new Map<string, unknown>();
    const database = {
      transaction: () => {
        const tx = {
          oncomplete: () => {},
          objectStore: () => ({
            get(key: string) {
              const request = { result: structuredClone(values.get(key)), onsuccess: () => {} };
              queueMicrotask(() => request.onsuccess());
              return request;
            },
            getAllKeys() {
              const request = { result: [...values.keys()], onsuccess: () => {} };
              queueMicrotask(() => request.onsuccess());
              return request;
            },
            put(value: unknown, key: string) {
              values.set(key, structuredClone(value));
            },
            delete(key: string) {
              values.delete(key);
            },
          }),
        };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      },
    };
    vi.stubGlobal("indexedDB", {
      open() {
        const request = { result: database, onsuccess: () => {} };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    });
    return { values, offline: await import("./offline.ts") };
  }

  it("deletes only the signed-out account and allows a fresh queue on later login", async () => {
    const { values, offline } = await setup();
    values.set("alice:articles", [{ id: "a" }]);
    values.set("bob:articles", [{ id: "b" }]);
    offline.setOfflineUser("alice");
    await offline.queuePatch("a", { favorite: true });
    await offline.clearOffline("alice");
    expect(values.has("alice:articles")).toBe(false);
    expect(values.has("alice:queue")).toBe(false);
    expect(values.get("bob:articles")).toEqual([{ id: "b" }]);
    expect(await offline.listOffline()).toEqual([]);
    await expect(offline.queuePatch("a", {})).rejects.toThrow("Sign in");
    offline.setOfflineUser("alice");
    await offline.queuePatch("new", { progress: 0.5 });
    expect(values.get("alice:queue")).toEqual([{ id: "new", patch: { progress: 0.5 } }]);
  });

  it("removes all other persisted accounts while retaining the accepted account", async () => {
    const { values, offline } = await setup();
    for (const id of ["alice", "bob", "carol"]) {
      values.set(`${id}:articles`, []);
      values.set(`${id}:queue`, []);
    }
    await offline.clearOtherOfflineUsers("bob");
    expect([...values.keys()].sort()).toEqual(["bob:articles", "bob:queue"]);
  });

  it("does not resurrect a queue when clearing races with an enqueue", async () => {
    const { values, offline } = await setup();
    offline.setOfflineUser("alice");
    await Promise.all([offline.queuePatch("a", { favorite: true }), offline.clearOffline("alice")]);
    expect(values.has("alice:queue")).toBe(false);
  });
});
