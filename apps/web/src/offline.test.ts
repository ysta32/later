import { describe, expect, it } from "vitest";
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
