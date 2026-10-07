import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Article, CaptureSource, Extracted } from "@later/core";
import { parseInbound } from "@later/core/email";
import { badRequest, readJson, type AppDeps, type AppEnv } from "../app.ts";
import { SESSION_COOKIE } from "../auth.ts";
import type { Repo } from "../repo.ts";
import { normalizeUrl } from "./articles.ts";

export function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (m || "capture failed").slice(0, 500);
}

/**
 * Save a URL by server-side fetch (shared by share target and email-in). An existing article that
 * did not fail is returned as-is; a failed fetch stores the article with captureStatus "failed".
 */
export async function saveByUrl(
  repo: Repo,
  deps: AppDeps,
  userId: string,
  url: string,
  source: CaptureSource,
  title: string | null = null,
): Promise<{ article: Article; created: boolean }> {
  const existing = repo.findArticleByUrl(userId, url);
  if (existing && existing.captureStatus !== "failed") return { article: existing, created: false };
  let extracted: Extracted | null = null;
  let captureError: string | null = null;
  try {
    extracted = await deps.extract.fetchAndExtract(url);
  } catch (err) {
    captureError = errMessage(err);
  }
  const existed = repo.findArticleByUrl(userId, url) !== null;
  const article = repo.saveArticle(userId, extracted, { url, source, title, captureError });
  return { article, created: !existed };
}

/** Constant-time string comparison (hashing first removes the length side channel). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const FIRST_URL = /https?:\/\/[^\s<>"']+/i;

/** First http(s) URL in free text (trailing punctuation trimmed), normalized. */
export function firstUrl(text: string): string | null {
  const m = FIRST_URL.exec(text);
  if (!m) return null;
  let candidate = m[0].replace(/[.,;:!?\]]+$/, "");
  while (
    candidate.endsWith(")") &&
    (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)
  )
    candidate = candidate.slice(0, -1).replace(/[.,;:!?\]]+$/, "");
  return normalizeUrl(candidate);
}

const MAX_FIELD = 25 * 1024 * 1024;

function field(v: unknown, name: string, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) badRequest(`${name} is required`);
    return undefined;
  }
  if (typeof v !== "string") badRequest(`${name} must be a string`);
  if (v.length > MAX_FIELD) badRequest(`${name} too long`);
  return v;
}

/** Read an inbound email: JSON {to, from, subject, html?, text?} or a provider-style form post. */
async function readInbound(c: Context<AppEnv>) {
  const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let b: Record<string, unknown>;
  if (ct === "multipart/form-data" || ct === "application/x-www-form-urlencoded") {
    let form: Record<string, unknown>;
    try {
      form = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      badRequest("invalid form body");
    }
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof form[k] === "string") return form[k];
      return undefined;
    };
    b = {
      to: pick("to", "To", "recipient"),
      from: pick("from", "From", "sender"),
      subject: pick("subject", "Subject"),
      html: pick("html", "body-html", "stripped-html"),
      text: pick("text", "body-plain", "stripped-text", "plain"),
    };
  } else {
    b = await readJson(c);
  }
  return {
    to: field(b.to, "to", true) as string,
    from: field(b.from, "from") ?? "",
    subject: (field(b.subject, "subject") ?? "").slice(0, 1000),
    html: field(b.html, "html"),
    text: field(b.text, "text"),
  };
}

const MINIMAL_BOOKMARKLET = `(function () {
  var s = document.currentScript;
  if (!s || !s.src) return;
  var src = new URL(s.src);
  var token = src.searchParams.get("token");
  if (!token) { alert("Later: missing token"); return; }
  fetch(src.origin + "/api/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ url: location.href, title: document.title, html: document.documentElement.outerHTML, source: "bookmarklet" })
  }).then(function (r) { alert(r.ok ? "Saved to Later" : "Later: save failed (" + r.status + ")"); },
          function () { alert("Later: network error"); });
})();
`;

const BOOKMARKLET_FILE = new URL("../static/bookmarklet.js", import.meta.url);

/** Routes mounted at the site root (not under /api): PWA share target and the bookmarklet script. */
export function shareRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/bookmarklet.js", async (c) => {
    let js: string;
    try {
      js = await readFile(BOOKMARKLET_FILE, "utf8");
    } catch {
      js = MINIMAL_BOOKMARKLET;
    }
    return c.body(js, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
  });

  r.get("/share", async (c) => {
    const q = c.req.query();
    const repo = c.get("repo");
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? repo.userForToken(token) : null;
    if (!user) {
      const next = new URL(c.req.url);
      return c.redirect(`/#/login?next=${encodeURIComponent(next.pathname + next.search)}`, 303);
    }
    // A GET that saves with cookie auth: refuse cross-site initiated requests (CSRF). A share-sheet
    // launch is a user navigation (Sec-Fetch-Site: none); old browsers send no header at all.
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none")
      return c.text("Cross-site share requests are not allowed", 403);
    const url = normalizeUrl(q.url) ?? firstUrl(q.text ?? "") ?? firstUrl(q.title ?? "") ?? null;
    if (!url) return c.text("Nothing to save: no http(s) URL was shared", 400);
    const title = (q.title ?? "").trim().slice(0, 1000) || null;
    const { article } = await saveByUrl(repo, c.get("deps"), user.id, url, "share", title);
    return c.redirect(`/#/saved/${encodeURIComponent(article.id)}`, 303);
  });

  return r;
}

/** /api routes for capture channels (email-in). Feeds live in feeds.ts. */
export function channelRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/inbound/email", async (c) => {
    const { config } = c.get("deps");
    if (!config.inboundSecret) throw new HTTPException(404, { message: "not found" });
    const given = c.req.header("x-later-inbound-secret") ?? "";
    if (!safeEqual(given, config.inboundSecret)) throw new HTTPException(401, { message: "unauthorized" });

    const email = await readInbound(c);
    const parsed = parseInbound(email);
    const repo = c.get("repo");
    const user = parsed.inboundToken ? repo.getUserByInboundToken(parsed.inboundToken) : null;
    if (!user) throw new HTTPException(404, { message: "unknown recipient" });

    if (parsed.url) {
      const url = normalizeUrl(parsed.url);
      if (!url) badRequest("invalid url in email");
      const { article, created } = await saveByUrl(
        repo,
        c.get("deps"),
        user.id,
        url,
        "email",
        email.subject.trim() || null,
      );
      return c.json(article, created ? 201 : 200);
    }
    const ex = parsed.extracted;
    if (!ex || !ex.textContent.trim()) throw new HTTPException(422, { message: "email has no content" });
    // Newsletter: stored as its own article (url "" is exempt from per-user URL uniqueness).
    const article = repo.saveArticle(
      user.id,
      { ...ex, url: "", title: ex.title.trim() || "Untitled email" },
      { url: "", source: "email", title: ex.title.trim() || "Untitled email" },
    );
    return c.json(article, 201);
  });

  return r;
}
