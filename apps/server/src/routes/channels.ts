import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { Article, CaptureSource, Extracted } from "@later/core";
import { parseInbound } from "@later/core/email";
import { assertSameOrigin, badRequest, readJson, type AppDeps, type AppEnv } from "../app.ts";
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

/** Share-form CSRF token: derived from (and only valid with) the caller's session token. */
export function shareCsrf(sessionToken: string): string {
  return createHash("sha256").update(`later-share-csrf:${sessionToken}`, "utf8").digest("base64url");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHARE_PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

function sharePage(url: string | null, title: string, csrf: string): string {
  const body = url
    ? `<h1>Save to Later?</h1>
<p class="t">${escapeHtml(title || url)}</p><p class="u">${escapeHtml(url)}</p>
<form method="post" action="/share">
<input type="hidden" name="url" value="${escapeHtml(url)}">
<input type="hidden" name="title" value="${escapeHtml(title)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" autofocus>Save</button> <a href="/#/">Cancel</a>
</form>`
    : `<h1>Nothing to save</h1><p>No http(s) link was shared.</p><p><a href="/#/">Back to Later</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Save to Later</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}
.u{color:#666;word-break:break-all;font-size:.9em}button{font:inherit;padding:.5rem 1.25rem;border-radius:.4rem;border:0;background:#222;color:#fff}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}.u{color:#aaa}}</style>
</head><body>${body}</body></html>`;
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

  /** Resolve the cookie-session user, or null. */
  const cookieUser = (c: Context<AppEnv>) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? c.get("repo").userForToken(token) : null;
    return user && token ? { user, token } : null;
  };
  const loginRedirect = (c: Context<AppEnv>) => {
    const next = new URL(c.req.url);
    return c.redirect(`/#/login?next=${encodeURIComponent(next.pathname + next.search)}`, 303);
  };

  // GET never mutates: it renders a confirm page whose same-origin POST (carrying a CSRF token
  // bound to the session) performs the save. The page refuses framing (no clickjacking).
  r.get("/share", (c) => {
    const q = c.req.query();
    const auth = cookieUser(c);
    if (!auth) return loginRedirect(c);
    const url = normalizeUrl(q.url) ?? firstUrl(q.text ?? "") ?? firstUrl(q.title ?? "") ?? null;
    const title = (q.title ?? "").trim().slice(0, 1000);
    return c.html(sharePage(url, title, shareCsrf(auth.token)), url ? 200 : 400, SHARE_PAGE_HEADERS);
  });

  r.post(
    "/share",
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("Request body too large", 413) }),
    async (c) => {
      const auth = cookieUser(c);
      if (!auth) return loginRedirect(c);
      assertSameOrigin(c, false);
      const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (ct !== "application/x-www-form-urlencoded" && ct !== "multipart/form-data")
        throw new HTTPException(415, { message: "expected a form post" });
      let form: Record<string, unknown>;
      try {
        form = (await c.req.parseBody()) as Record<string, unknown>;
      } catch {
        badRequest("invalid form body");
      }
      const csrf = typeof form.csrf === "string" ? form.csrf : "";
      if (!safeEqual(csrf, shareCsrf(auth.token)))
        throw new HTTPException(403, { message: "invalid CSRF token" });
      const url = normalizeUrl(form.url);
      if (!url) badRequest("a valid http(s) url is required");
      const title = typeof form.title === "string" ? form.title.trim().slice(0, 1000) || null : null;
      const { article } = await saveByUrl(c.get("repo"), c.get("deps"), auth.user.id, url, "share", title);
      return c.redirect(`/#/saved/${encodeURIComponent(article.id)}`, 303);
    },
  );

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
