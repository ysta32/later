// FROZEN CONTRACT: thin typed client over docs/API.md. Shared by library shell and reader.
import type { Article, Highlight, Feed, User, ImportFormat } from "@later/core/types";
export type { Article, Highlight, Feed, User };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const init: RequestInit = { method, credentials: "include", headers: {} };
  if (body instanceof Blob || body instanceof FormData) init.body = body;
  else if (body !== undefined) { (init.headers as Record<string, string>)["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (raw ? res.blob() : res.json()) as Promise<T>;
}

export const api = {
  signup: (email: string, password: string) => req<{ user: User; token: string }>("POST", "/api/auth/signup", { email, password }),
  login: (email: string, password: string) => req<{ user: User; token: string }>("POST", "/api/auth/login", { email, password }),
  logout: () => req<void>("POST", "/api/auth/logout"),
  me: () => req<{ user: User }>("GET", "/api/me"),
  updateMe: (p: { kindleEmail?: string | null }) => req<{ user: User }>("PATCH", "/api/me", p),
  createToken: (label: string) => req<{ token: string }>("POST", "/api/tokens", { label }),

  list: (q: { state?: "inbox" | "archived" | "all"; tag?: string; favorite?: boolean; q?: string; cursor?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, k === "favorite" ? (v ? "1" : "") : String(v));
    return req<{ items: Article[]; nextCursor: string | null }>("GET", `/api/articles?${p}`);
  },
  save: (url: string, extra: { html?: string; title?: string; tags?: string[] } = {}) => req<Article>("POST", "/api/articles", { url, ...extra }),
  get: (id: string) => req<Article>("GET", `/api/articles/${id}`),
  update: (id: string, p: Partial<Pick<Article, "state" | "favorite" | "progress" | "tags" | "title">>) => req<Article>("PATCH", `/api/articles/${id}`, p),
  remove: (id: string) => req<void>("DELETE", `/api/articles/${id}`),
  refetch: (id: string) => req<Article>("POST", `/api/articles/${id}/refetch`),
  search: (q: string) => req<{ items: (Article & { snippet: string })[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  tags: () => req<{ tags: { tag: string; count: number }[] }>("GET", "/api/tags"),

  highlights: (articleId: string) => req<{ items: Highlight[] }>("GET", `/api/articles/${articleId}/highlights`),
  addHighlight: (articleId: string, h: { quote: string; prefix: string; suffix: string; note?: string | null; color?: Highlight["color"] }) =>
    req<Highlight>("POST", `/api/articles/${articleId}/highlights`, h),
  updateHighlight: (id: string, p: { note?: string | null; color?: Highlight["color"] }) => req<Highlight>("PATCH", `/api/highlights/${id}`, p),
  deleteHighlight: (id: string) => req<void>("DELETE", `/api/highlights/${id}`),
  allHighlights: () => req<{ items: (Highlight & { articleTitle: string; articleUrl: string })[] }>("GET", "/api/highlights"),

  feeds: () => req<{ items: Feed[] }>("GET", "/api/feeds"),
  addFeed: (url: string) => req<Feed>("POST", "/api/feeds", { url }),
  deleteFeed: (id: string) => req<void>("DELETE", `/api/feeds/${id}`),
  refreshFeeds: () => req<{ added: number }>("POST", "/api/feeds/refresh"),

  importFile: (format: ImportFormat, file: Blob) => req<{ imported: number; skipped: number; failed: number }>("POST", `/api/import?format=${format}`, file),
  sendToKindle: (id: string) => req<void>("POST", `/api/articles/${id}/kindle`),

  aiStatus: () => req<{ enabled: boolean; model: string }>("GET", "/api/ai/status"),
  summarize: (id: string) => req<{ summary: string; method: "claude" | "extractive" }>("POST", `/api/articles/${id}/summary`),
  ask: (question: string) => req<{ answer: string; method: "claude" | "search"; sources: { id: string; title: string; url: string }[] }>("POST", "/api/ask", { question }),
};

/** Download URLs (plain links; cookie auth). */
export const links = {
  epub: (id: string) => `/api/articles/${id}/epub`,
  exportJson: "/api/export.json",
  exportMarkdownZip: "/api/export.md.zip",
};
