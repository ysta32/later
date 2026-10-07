import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { buildPayload } from "./content-capture.js";
import type LaterPlugin from "../../obsidian/main.ts";

const extension = new URL("../", import.meta.url);
const bookmarklet = new URL("../server/src/static/bookmarklet.js", extension);
const bookmarkletSource = readFileSync(bookmarklet, "utf8");
const doc = {
  title: "A private article",
  documentElement: { outerHTML: "<html><body>Rendered subscriber content</body></html>" },
};
const pageLocation = { href: "https://publisher.example/story?a=1&b=2" };

describe("capture payloads", () => {
  it("captures the rendered DOM without fetching the page", () => {
    expect(buildPayload(doc, pageLocation)).toEqual({
      url: pageLocation.href,
      title: doc.title,
      html: doc.documentElement.outerHTML,
    });
  });

  it("exports the bookmarklet builder for pure execution", () => {
    const module = { exports: {} as { buildPayload: typeof buildPayload } };
    runInNewContext(bookmarkletSource, { module });
    expect(module.exports.buildPayload(doc, pageLocation)).toEqual({
      ...buildPayload(doc, pageLocation),
      source: "bookmarklet",
    });
  });

  it("has a valid MV3 manifest and syntactically valid JavaScript", () => {
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", extension), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "storage", "contextMenus"]),
    );
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.browser_specific_settings.gecko.id).toBe("later@ysta32");
    expect(manifest.commands["save-to-later"].suggested_key.default).toBe("Alt+Shift+L");
    const scripts = readdirSync(new URL("src/", extension)).filter((name) => name.endsWith(".js"));
    for (const script of [...scripts.map((name) => new URL(`src/${name}`, extension)), bookmarklet]) {
      expect(() =>
        execFileSync(process.execPath, ["--check", fileURLToPath(script)], { stdio: "pipe" }),
      ).not.toThrow();
    }
  });
});

function bookmarkletContext(fetchMock: ReturnType<typeof vi.fn>) {
  const messages: string[] = [];
  const open = vi.fn();
  const context = {
    URL,
    location: pageLocation,
    fetch: fetchMock,
    window: { open },
    setTimeout: vi.fn(),
    document: {
      title: doc.title,
      currentScript: { src: "https://later.example/bookmarklet.js?token=test-token" },
      documentElement: {
        ...doc.documentElement,
        appendChild: (element: { textContent: string }) => messages.push(element.textContent),
      },
      createElement: () => ({ textContent: "", style: {}, setAttribute: vi.fn(), remove: vi.fn() }),
    },
  };
  runInNewContext(bookmarkletSource, context);
  return { messages, open };
}

describe("bookmarklet delivery", () => {
  it("uses its script origin, bearer auth, rendered content, and no cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const { messages, open } = bookmarkletContext(fetchMock);
    await vi.waitFor(() => expect(messages).toContain("Saved to Later."));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://later.example/api/articles",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      ...buildPayload(doc, pageLocation),
      source: "bookmarklet",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back without leaking the token or rendered HTML on CORS failure", async () => {
    const { open } = bookmarkletContext(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        `https://later.example/share?url=${encodeURIComponent(pageLocation.href)}`,
        "_blank",
        "noopener,noreferrer",
      ),
    );
  });

  it("reports HTTP failure without opening a duplicate save", async () => {
    const { messages, open } = bookmarkletContext(vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await vi.waitFor(() => expect(messages).toContain("Later: save failed (HTTP 401)."));
    expect(open).not.toHaveBeenCalled();
  });
});

function background() {
  const listeners: Record<string, (...args: any[]) => any> = {};
  const event = (name: string) => ({
    addListener: (callback: (...args: any[]) => any) => {
      listeners[name] = callback;
    },
  });
  const api = {
    runtime: { id: "later-test", onInstalled: event("installed"), onMessage: event("message") },
    contextMenus: {
      onClicked: event("context"),
      removeAll: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
    },
    commands: { onCommand: event("command") },
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    action: { setBadgeText: vi.fn().mockResolvedValue(undefined) },
    storage: {
      sync: { get: vi.fn().mockResolvedValue({ serverUrl: "https://later.example", token: "test-token" }) },
      local: { set: vi.fn().mockResolvedValue(undefined) },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: buildPayload(doc, pageLocation) }]) },
  };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "article-1" }) });
  const source = readFileSync(new URL("src/background.js", extension), "utf8").replace(/^import .*;\n/, "");
  runInNewContext(source, { browser: api, buildPayload, fetch: fetchMock, URL, Error });
  return { api, listeners, fetchMock };
}

describe("extension background", () => {
  it("injects the capture function for the shortcut and saves from the background", async () => {
    const { api, listeners, fetchMock } = background();
    await listeners.command!("save-to-later");
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, func: buildPayload });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://later.example/api/articles",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      ...buildPayload(doc, pageLocation),
      source: "extension",
    });
    expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 42, text: "✓" });
  });

  it("saves link targets without capturing the current page", async () => {
    const { api, listeners, fetchMock } = background();
    listeners.context!({ menuItemId: "save-to-later", linkUrl: "https://example.org/target" }, { id: 42 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      url: "https://example.org/target",
      source: "extension",
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("reports failures and never sends a token without server permission", async () => {
    const { api, listeners, fetchMock } = background();
    api.permissions.contains.mockResolvedValue(false);
    await listeners.command!("save-to-later");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 42, text: "!" });
  });

  it("returns popup status and rejects foreign senders", async () => {
    const { listeners } = background();
    const reply = vi.fn();
    expect(listeners.message!({ type: "save-active" }, { id: "foreign" }, reply)).toBe(false);
    expect(listeners.message!({ type: "save-active" }, { id: "later-test" }, reply)).toBe(true);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, url: "https://later.example/#/saved/article-1" }),
      ),
    );
  });
});

function obsidian() {
  const requestUrl = vi
    .fn()
    .mockResolvedValue({
      status: 200,
      json: { articles: [{ path: "2026/story.md", markdown: "# Story" }], cursor: "next" },
    });
  const write = vi.fn().mockResolvedValue(undefined);
  const saveData = vi.fn().mockResolvedValue(undefined);
  class Plugin {
    app = {
      vault: {
        adapter: {
          exists: vi.fn().mockResolvedValue(false),
          mkdir: vi.fn().mockResolvedValue(undefined),
          write,
        },
      },
    };
    saveData = saveData;
  }
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL("../obsidian/main.ts", extension), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(compiled.outputText, {
    exports,
    URL,
    require: () => ({ Plugin, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, requestUrl }),
  });
  const plugin: LaterPlugin = new exports.default();
  plugin.settings.token = "test-token";
  return { plugin, requestUrl, write, saveData };
}

describe("Obsidian sync", () => {
  it("compiles against its standalone declarations", () => {
    const main = fileURLToPath(new URL("../obsidian/main.ts", extension));
    const program = ts.createProgram([main], {
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  it("writes beneath the folder and persists the cursor after writes", async () => {
    const { plugin, requestUrl, write, saveData } = obsidian();
    plugin.settings.cursor = "previous";
    await plugin.sync(true);
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:4800/api/obsidian/sync?since=previous",
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    expect(write).toHaveBeenCalledWith("Later/2026/story.md", "# Story");
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next" }));
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(saveData.mock.invocationCallOrder[0]!);
  });

  it.each(["../escape.md", "/absolute.md", "foo/../../escape.md", "foo\\escape.md", ".obsidian/config.md"])(
    "rejects unsafe server path %s before writing",
    async (path) => {
      const { plugin, requestUrl, write, saveData } = obsidian();
      requestUrl.mockResolvedValue({
        status: 200,
        json: { articles: [{ path, markdown: "bad" }], cursor: "next" },
      });
      await plugin.sync(true);
      expect(write).not.toHaveBeenCalled();
      expect(saveData).not.toHaveBeenCalled();
    },
  );

  it("keeps the old cursor after a failed write and allows retry", async () => {
    const { plugin, write, saveData } = obsidian();
    plugin.settings.cursor = "previous";
    write.mockRejectedValueOnce(new Error("Disk full"));
    await plugin.sync(true);
    expect(plugin.settings.cursor).toBe("previous");
    expect(saveData).not.toHaveBeenCalled();
    await plugin.sync(true);
    expect(plugin.settings.cursor).toBe("next");
  });

  it("resets the cursor when the destination changes", async () => {
    const { plugin } = obsidian();
    plugin.settings.cursor = "previous";
    await plugin.configure("https://later.example", "new-token", "Articles");
    expect(plugin.settings.cursor).toBe("");
    expect(plugin.settings.folder).toBe("Articles");
  });
});
