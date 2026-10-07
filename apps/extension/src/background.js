import { buildPayload } from "./content-capture.js";

const api = globalThis.browser ?? chrome;
const pending = new Map();

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll().then(() => {
    api.contextMenus.create({ id: "save-to-later", title: "Save to Later", contexts: ["page", "link"] });
  });
});

function serverOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Set a valid HTTP or HTTPS server in Options.");
  }
  return url.origin;
}

async function save(tab, linkUrl) {
  const tabId = tab?.id;
  let origin;
  try {
    if (!Number.isInteger(tabId)) throw new Error("No active page to save.");
    await api.action.setBadgeText({ tabId, text: "…" });
    const settings = await api.storage.sync.get({ serverUrl: "http://localhost:4800", token: "" });
    origin = serverOrigin(settings.serverUrl);
    if (!settings.token.trim()) throw new Error("Add your API token in Options.");
    const server = new URL(origin);
    if (!(await api.permissions.contains({ origins: [`${server.protocol}//${server.hostname}/*`] }))) {
      throw new Error("Save your server settings in Options to grant access.");
    }
    let payload;
    if (linkUrl) {
      const link = new URL(linkUrl);
      if (!["http:", "https:"].includes(link.protocol))
        throw new Error("Only HTTP and HTTPS links can be saved.");
      payload = { url: link.href, source: "extension" };
    } else {
      const results = await api.scripting.executeScript({ target: { tabId }, func: buildPayload });
      if (!results[0]?.result) throw new Error("This page cannot be captured.");
      payload = { ...results[0].result, source: "extension" };
    }
    const response = await fetch(`${origin}/api/articles`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token.trim()}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Save failed (HTTP ${response.status}).`);
    const article = await response.json();
    const status = {
      ok: true,
      message:
        article.captureStatus === "failed"
          ? "Link saved; content could not be extracted."
          : "Saved to Later.",
      url: `${origin}/#/saved/${encodeURIComponent(article.id)}`,
    };
    await api.action.setBadgeText({ tabId, text: "✓" });
    await api.storage.local.set({ [`status:${tabId}`]: status });
    return status;
  } catch (error) {
    const status = {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save this page.",
      url: origin,
    };
    if (Number.isInteger(tabId)) {
      await api.action.setBadgeText({ tabId, text: "!" });
      await api.storage.local.set({ [`status:${tabId}`]: status });
    }
    return status;
  }
}

function saveOnce(tab, linkUrl) {
  const key = `${tab?.id}:${linkUrl ?? "page"}`;
  if (!pending.has(key)) {
    pending.set(
      key,
      save(tab, linkUrl).finally(() => pending.delete(key)),
    );
  }
  return pending.get(key);
}

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "save-to-later") void saveOnce(tab, info.linkUrl);
});
api.commands.onCommand.addListener(async (command) => {
  if (command !== "save-to-later") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  await saveOnce(tab);
});
api.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== api.runtime.id || message?.type !== "save-active") return false;
  api.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => saveOnce(tab))
    .then(reply, () => reply({ ok: false, message: "Could not access the active page." }));
  return true;
});
