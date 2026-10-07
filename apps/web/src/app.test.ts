import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./reader/Reader.tsx", () => ({ default: () => null }));

import App, { parseRoute, readingTime } from "./app.tsx";
import { bookmarklet, detectImportFormat } from "./pages/Settings.tsx";

describe("hash routing", () => {
  it.each(["archive", "favorites", "search", "highlights", "ask", "settings"])("routes %s", (page) => {
    expect(parseRoute(`#/${page}`)).toEqual({ page });
  });
  it("decodes tags and article ids without interpreting encoded slashes", () => {
    expect(parseRoute("#/tag/slow%20living%2Fbooks")).toEqual({
      page: "tag",
      value: "slow living/books",
    });
    expect(parseRoute("#/read/abc-123")).toEqual({
      page: "read",
      value: "abc-123",
    });
    expect(parseRoute("#/saved/123")).toEqual({ page: "saved", value: "123" });
  });
  it.each(["", "#/", "#/unknown", "#/read/", "#/tag/%E0%A4%A", "#/read/a/b"])(
    "safely defaults %s",
    (hash) => {
      expect(parseRoute(hash)).toEqual({ page: "inbox" });
    },
  );
});
describe("reading time", () => {
  it.each([
    [0, 1],
    [230, 1],
    [231, 2],
    [920, 4],
    [-20, 1],
    [NaN, 1],
    [Infinity, 1],
  ])("%s words takes %s minutes", (words, minutes) => {
    expect(readingTime(words)).toBe(minutes);
  });
});
describe("capture settings", () => {
  it("loads the same-origin bookmarklet script with an encoded token", () => {
    const code = bookmarklet("https://later.example", "a&b'c");
    let source = "";
    const document = {
      createElement: () => ({ src: "" }),
      body: {
        appendChild: (script: { src: string }) => {
          source = script.src;
        },
      },
    };
    new Function("document", code.slice("javascript:".length))(document);
    expect(new URL(source).origin).toBe("https://later.example");
    expect(new URL(source).pathname).toBe("/bookmarklet.js");
    expect(new URL(source).searchParams.get("token")).toBe("a&b'c");
  });
  it("detects known exports and leaves unknown formats for explicit selection", () => {
    expect(detectImportFormat("ril_export.html", "<html>")).toBe("pocket");
    expect(detectImportFormat("data.html", "<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe("bookmarks");
    expect(detectImportFormat("instapaper.csv", "URL,Title")).toBe("instapaper");
    expect(detectImportFormat("unknown.json", "{}")).toBeNull();
  });
});

const hooks = vi.hoisted(() => ({ states: [] as unknown[], effects: [] as (() => unknown)[] }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: () => [hooks.states.shift(), vi.fn()],
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));
import { api, ApiError } from "./api.ts";
import * as offline from "./offline.ts";

function findProps(
  node: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, predicate);
      if (found) return found;
    }
    return;
  }
  const element = node as { type: unknown; props?: Record<string, unknown> };
  if (!element.props) return;
  return predicate(element.type, element.props)
    ? element.props
    : findProps(element.props.children, predicate);
}

describe("offline session integration", () => {
  const user = { id: "alice", email: "alice@example.com" };
  let stored: Map<string, string>;
  beforeEach(() => {
    hooks.effects = [];
    hooks.states = [{ page: "read", value: "a" }, user, false, "", true, "system"];
    stored = new Map([["later-user", JSON.stringify(user)]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { hash: "#/read/a" });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.spyOn(offline, "clearOffline").mockResolvedValue();
    vi.spyOn(offline, "clearOtherOfflineUsers").mockResolvedValue();
    vi.spyOn(offline, "setOfflineUser").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supplies the Reader with cached articles and normalizes cache misses to null", async () => {
    const load = findProps(App(), (type) => typeof type === "function")!.loadOffline as (
      id: string,
    ) => Promise<unknown>;
    const cached = { id: "a" } as Awaited<ReturnType<typeof offline.getOfflineArticle>>;
    const get = vi
      .spyOn(offline, "getOfflineArticle")
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce(undefined);
    expect(await load("a")).toBe(cached);
    expect(await load("missing")).toBeNull();
    expect(get.mock.calls).toEqual([["a"], ["missing"]]);
  });

  it("attempts replay before logout and clears the account even if replay fails", async () => {
    const order: string[] = [];
    vi.spyOn(offline, "replayOffline").mockImplementation(async () => {
      order.push("replay");
      throw new Error("offline");
    });
    vi.spyOn(api, "logout").mockImplementation(async () => {
      order.push("logout");
    });
    vi.mocked(offline.clearOffline).mockImplementation(async () => {
      order.push("clear");
    });
    const click = findProps(App(), (type, props) => type === "button" && props.children === "Sign out")!
      .onClick as () => Promise<void>;
    await click();
    expect(order).toEqual(["replay", "logout", "clear"]);
    expect(offline.clearOffline).toHaveBeenCalledWith("alice");
    expect(stored.has("later-user")).toBe(false);
    expect(offline.setOfflineUser).toHaveBeenCalledWith(null);
  });

  it("removes the local session when storage cleanup fails after logout", async () => {
    vi.spyOn(offline, "replayOffline").mockResolvedValue();
    vi.spyOn(api, "logout").mockResolvedValue();
    vi.mocked(offline.clearOffline).mockRejectedValue(new Error("Storage unavailable"));
    const click = findProps(App(), (type, props) => type === "button" && props.children === "Sign out")!
      .onClick as () => Promise<void>;
    await click();
    expect(stored.has("later-user")).toBe(false);
    expect(offline.setOfflineUser).toHaveBeenCalledWith(null);
  });

  it("clears the cached account when session validation returns 401", async () => {
    vi.spyOn(api, "me").mockRejectedValue(new ApiError(401, "Unauthorized"));
    App();
    hooks.effects[0]!();
    await vi.waitFor(() => expect(offline.clearOffline).toHaveBeenCalledWith("alice"));
    expect(stored.has("later-user")).toBe(false);
    expect(offline.setOfflineUser).toHaveBeenCalledWith(null);
  });

  it("clears other accounts before accepting the validated user", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ user: { ...user, id: "bob" } } as Awaited<
      ReturnType<typeof api.me>
    >);
    App();
    hooks.effects[0]!();
    await vi.waitFor(() => expect(offline.setOfflineUser).toHaveBeenCalledWith("bob"));
    expect(offline.clearOtherOfflineUsers).toHaveBeenCalledWith("bob");
    expect(JSON.parse(stored.get("later-user")!).id).toBe("bob");
  });
});
