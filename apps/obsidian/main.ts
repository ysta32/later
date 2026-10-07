/// <reference path="./obsidian.d.ts" />
import { Notice, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";

interface Settings {
  serverUrl: string;
  token: string;
  folder: string;
  cursor: string;
}

const defaults: Settings = { serverUrl: "http://localhost:4800", token: "", folder: "Later", cursor: "" };

export function safePath(value: string): string {
  const parts = value.split("/");
  if (
    !value ||
    parts.some((part) => !part || part === "." || part === "..") ||
    /[\\:\x00-\x1f]/.test(value)
  ) {
    throw new Error("Use a relative vault path without empty, dot, or parent segments.");
  }
  return parts.join("/");
}

function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Enter an HTTP or HTTPS server URL without credentials.");
  }
  return url.origin;
}

function parseSync(value: unknown): { articles: { path: string; markdown: string }[]; cursor: string } {
  if (
    !value ||
    typeof value !== "object" ||
    !("articles" in value) ||
    !("cursor" in value) ||
    !Array.isArray(value.articles) ||
    typeof value.cursor !== "string"
  ) {
    throw new Error("Invalid sync response.");
  }
  const articles = value.articles.map((article: unknown) => {
    if (
      !article ||
      typeof article !== "object" ||
      !("path" in article) ||
      !("markdown" in article) ||
      typeof article.path !== "string" ||
      typeof article.markdown !== "string"
    ) {
      throw new Error("Invalid article in sync response.");
    }
    const path = safePath(article.path);
    if (!path.endsWith(".md") || path.split("/").some((part) => part.startsWith("."))) {
      throw new Error("Sync paths must be Markdown files outside hidden folders.");
    }
    return { path, markdown: article.markdown };
  });
  return { articles, cursor: value.cursor };
}

export default class LaterPlugin extends Plugin {
  settings: Settings = { ...defaults };
  syncing = false;

  async onload(): Promise<void> {
    const stored = await this.loadData();
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(defaults) as (keyof Settings)[]) {
        if (key in stored && typeof stored[key as keyof typeof stored] === "string") {
          this.settings[key] = stored[key as keyof typeof stored] as string;
        }
      }
    }
    this.addCommand({ id: "sync-later", name: "Sync Later", callback: () => this.sync(true) });
    this.addSettingTab(new LaterSettings(this));
    this.registerInterval(
      window.setInterval(
        () => {
          void this.sync(false);
        },
        5 * 60 * 1000,
      ),
    );
  }

  async configure(serverUrl: string, token: string, folder: string): Promise<void> {
    if (this.syncing) throw new Error("Wait for the current sync to finish.");
    const next = {
      serverUrl: origin(serverUrl),
      token: token.trim(),
      folder: safePath(folder.trim()),
      cursor: "",
    };
    if (!next.token) throw new Error("Enter an API token.");
    if (next.folder.split("/").some((part) => part.startsWith(".")))
      throw new Error("Choose a folder outside hidden vault folders.");
    if (
      next.serverUrl === this.settings.serverUrl &&
      next.token === this.settings.token &&
      next.folder === this.settings.folder
    ) {
      next.cursor = this.settings.cursor;
    }
    this.syncing = true;
    try {
      await this.saveData(next);
      this.settings = next;
    } finally {
      this.syncing = false;
    }
  }

  async sync(manual: boolean): Promise<void> {
    if (this.syncing) {
      if (manual) new Notice("Later sync is already running.");
      return;
    }
    if (!this.settings.token) {
      if (manual) new Notice("Configure Later in plugin settings first.");
      return;
    }
    this.syncing = true;
    try {
      const folder = safePath(this.settings.folder);
      if (folder.split("/").some((part) => part.startsWith(".")))
        throw new Error("Choose a folder outside hidden vault folders.");
      const url = new URL("/api/obsidian/sync", origin(this.settings.serverUrl));
      if (this.settings.cursor) url.searchParams.set("since", this.settings.cursor);
      const response = await requestUrl({
        url: url.href,
        method: "GET",
        throw: false,
        headers: { Authorization: `Bearer ${this.settings.token}` },
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Sync failed (HTTP ${response.status}).`);
      const result = parseSync(response.json);
      for (const article of result.articles) {
        const path = `${folder}/${article.path}`;
        const parents = path.split("/").slice(0, -1);
        for (let i = 1; i <= parents.length; i++) {
          const parent = parents.slice(0, i).join("/");
          if (!(await this.app.vault.adapter.exists(parent))) await this.app.vault.adapter.mkdir(parent);
        }
        await this.app.vault.adapter.write(path, article.markdown);
      }
      const next = { ...this.settings, cursor: result.cursor };
      await this.saveData(next);
      this.settings = next;
      if (manual) new Notice(`Later: synced ${result.articles.length} articles.`);
    } catch {
      new Notice(
        "Later sync failed. Check the server, token, folder, and connection; the cursor has not advanced.",
      );
    } finally {
      this.syncing = false;
    }
  }
}

class LaterSettings extends PluginSettingTab {
  plugin: LaterPlugin;

  constructor(plugin: LaterPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    const draft = { ...this.plugin.settings };
    for (const [key, label] of [
      ["serverUrl", "Server URL"],
      ["token", "API token"],
      ["folder", "Folder"],
    ] as const) {
      new Setting(this.containerEl).setName(label).addText((text) => {
        if (key === "token") text.inputEl.type = "password";
        text.setValue(draft[key]).onChange((value) => {
          draft[key] = value;
        });
      });
    }
    new Setting(this.containerEl)
      .setName("Save settings")
      .setDesc("Sync runs every five minutes. Changing settings resets the sync cursor.")
      .addButton((button) =>
        button.setButtonText("Save").onClick(async () => {
          try {
            await this.plugin.configure(draft.serverUrl, draft.token, draft.folder);
            new Notice("Later settings saved.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Could not save settings.");
          }
        }),
      );
  }
}
