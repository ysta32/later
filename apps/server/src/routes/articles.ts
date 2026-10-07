import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ArticleState, CaptureSource, Extracted } from "@later/core";
import { badRequest, readJson, requireAuth, type AppEnv } from "../app.ts";
import { CAPTURE_SOURCES, normalizeTags, type ArticlePatch } from "../repo.ts";

const MAX_URL = 4096;
const MAX_BODY = 20 * 1024 * 1024;

/** Validate and normalize an article URL (http/https only, fragment dropped). */
export function normalizeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.href;
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (m || "capture failed").slice(0, 500);
}

function parseTags(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((t) => typeof t === "string"))
    badRequest("tags must be an array of strings");
  return normalizeTags(v);
}

export function articleRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/articles", requireAuth, (c) => {
    const q = c.req.query();
    const state = q.state || "all";
    if (state !== "inbox" && state !== "archived" && state !== "all")
      badRequest("state must be inbox, archived or all");
    const limit = q.limit ? Number(q.limit) : 50;
    if (!Number.isFinite(limit)) badRequest("limit must be a number");
    try {
      const page = c.get("repo").listArticles(c.get("user").id, {
        state,
        tag: q.tag || undefined,
        favorite: q.favorite === "1" || q.favorite === "true",
        q: q.q || undefined,
        limit,
        cursor: q.cursor || null,
      });
      return c.json(page);
    } catch (err) {
      if (err instanceof RangeError) badRequest("invalid cursor");
      throw err;
    }
  });

  r.post(
    "/articles",
    requireAuth,
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "request body too large" }, 413) }),
    async (c) => {
      const repo = c.get("repo");
      const { extract } = c.get("deps");
      const userId = c.get("user").id;
      const body = await readJson(c);
      const url = normalizeUrl(body.url);
      if (!url) badRequest("a valid http(s) url is required");
      const html = body.html;
      if (html !== undefined && html !== null && typeof html !== "string")
        badRequest("html must be a string");
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 1000) || null : null;
      const tags = parseTags(body.tags);
      let source: CaptureSource;
      if (body.source === undefined || body.source === null) source = html ? "extension" : "server";
      else if (
        typeof body.source === "string" &&
        (CAPTURE_SOURCES as readonly string[]).includes(body.source)
      )
        source = body.source as CaptureSource;
      else badRequest("invalid source");

      // Duplicate without new DOM: return the existing article (merging tags) unless its capture failed (then retry).
      if (!html) {
        const existing = repo.findArticleByUrl(userId, url);
        if (existing && existing.captureStatus !== "failed") {
          if (tags?.length) repo.setTags(userId, existing.id, normalizeTags([...existing.tags, ...tags]));
          return c.json(repo.getArticle(userId, existing.id), 200);
        }
      }

      let extracted: Extracted | null = null;
      let captureError: string | null = null;
      if (html) {
        try {
          extracted = extract.extractFromHtml(html, url);
        } catch (err) {
          captureError = errMessage(err);
        }
      }
      if (!extracted) {
        try {
          extracted = await extract.fetchAndExtract(url);
          captureError = null;
        } catch (err) {
          captureError = captureError ? `${captureError}; fetch: ${errMessage(err)}` : errMessage(err);
        }
      }

      // Synchronous from here: existence check and upsert cannot interleave with another request.
      const existed = repo.findArticleByUrl(userId, url) !== null;
      const article = repo.saveArticle(userId, extracted, { url, source, tags, title, captureError });
      return c.json(article, existed ? 200 : 201);
    },
  );

  r.get("/articles/:id", requireAuth, (c) => {
    const a = c.get("repo").getArticle(c.get("user").id, c.req.param("id"));
    if (!a) throw new HTTPException(404, { message: "article not found" });
    return c.json(a);
  });

  r.patch("/articles/:id", requireAuth, async (c) => {
    const body = await readJson(c);
    const patch: ArticlePatch = {};
    if (body.state !== undefined) {
      if (body.state !== "inbox" && body.state !== "archived") badRequest("state must be inbox or archived");
      patch.state = body.state as ArticleState;
    }
    if (body.favorite !== undefined) {
      if (typeof body.favorite !== "boolean") badRequest("favorite must be a boolean");
      patch.favorite = body.favorite;
    }
    if (body.progress !== undefined) {
      if (typeof body.progress !== "number" || !Number.isFinite(body.progress))
        badRequest("progress must be a number");
      patch.progress = Math.min(1, Math.max(0, body.progress));
    }
    if (body.title !== undefined) {
      const t = typeof body.title === "string" ? body.title.trim().slice(0, 1000) : "";
      if (!t) badRequest("title must be a non-empty string");
      patch.title = t;
    }
    if (body.tags !== undefined) {
      const t = parseTags(body.tags);
      if (!t) badRequest("tags must be an array of strings");
      patch.tags = t;
    }
    const a = c.get("repo").updateArticle(c.get("user").id, c.req.param("id"), patch);
    if (!a) throw new HTTPException(404, { message: "article not found" });
    return c.json(a);
  });

  r.delete("/articles/:id", requireAuth, (c) => {
    if (!c.get("repo").deleteArticle(c.get("user").id, c.req.param("id")))
      throw new HTTPException(404, { message: "article not found" });
    return c.body(null, 204);
  });

  r.post("/articles/:id/refetch", requireAuth, async (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const a = repo.getArticle(userId, id);
    if (!a) throw new HTTPException(404, { message: "article not found" });
    if (!a.url) badRequest("article has no url to refetch");
    let extracted: Extracted;
    try {
      extracted = await c.get("deps").extract.fetchAndExtract(a.url);
    } catch (err) {
      const msg = errMessage(err);
      repo.replaceContent(userId, id, null, msg);
      throw new HTTPException(502, { message: `refetch failed: ${msg}` });
    }
    const updated = repo.replaceContent(userId, id, extracted);
    if (!updated) throw new HTTPException(404, { message: "article not found" });
    return c.json(updated);
  });

  r.get("/search", requireAuth, (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 500);
    return c.json({ items: c.get("repo").search(c.get("user").id, q) });
  });

  r.get("/tags", requireAuth, (c) => c.json({ tags: c.get("repo").tagCounts(c.get("user").id) }));

  return r;
}
