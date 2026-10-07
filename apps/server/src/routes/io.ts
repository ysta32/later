import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { Unzip, UnzipInflate } from "fflate";
import type { Article, ExportBundle, Extracted, ImportFormat, ImportItem } from "@later/core";
import { detectFormat, parseImport } from "@later/core/importers";
import { articleToMarkdown, exportJson, markdownZip } from "@later/core/exporters";
import { buildEpub } from "@later/core/epub";
import { countWords, htmlToText, sanitizeHtml } from "@later/core/sanitize";
import { badRequest, requireAuth, type AppEnv, type Extractor } from "../app.ts";
import { RateLimiter } from "../auth.ts";
import { createSmtpMailer, defaultMailFrom } from "../mailer.ts";
import { normalizeTags, type Repo } from "../repo.ts";
import { normalizeUrl } from "./articles.ts";
import { errMessage } from "./channels.ts";

type Job = () => Promise<void>;

/**
 * In-process background job queue: bounded global concurrency, round-robin fairness across keys
 * (users), and de-duplication by job id (an id queued or running is not enqueued again).
 * Job errors are logged, never thrown.
 */
export class TaskQueue {
  private readonly concurrency: number;
  /** Per-key FIFO; Map insertion order is the round-robin order. */
  private readonly lanes = new Map<string, { id: string; job: Job }[]>();
  private readonly ids = new Set<string>();
  private readonly perKey = new Map<string, number>();
  private running = 0;
  private idle: (() => void)[] = [];
  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }
  /** Jobs queued or running. */
  get size(): number {
    return this.ids.size;
  }
  /** Jobs queued or running for one key. */
  sizeFor(key: string): number {
    return this.perKey.get(key) ?? 0;
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  /** Enqueue; returns false if a job with this id is already queued or running. */
  push(key: string, id: string, job: Job): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.perKey.set(key, this.sizeFor(key) + 1);
    const lane = this.lanes.get(key);
    if (lane) lane.push({ id, job });
    else this.lanes.set(key, [{ id, job }]);
    this.pump();
    return true;
  }
  /** Resolves when no jobs are queued or running. */
  drain(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
  private next(): { key: string; id: string; job: Job } | null {
    for (const [key, lane] of this.lanes) {
      const item = lane.shift() as { id: string; job: Job };
      // Rotate: this key goes to the back of the round-robin (or leaves when empty).
      this.lanes.delete(key);
      if (lane.length) this.lanes.set(key, lane);
      return { key, ...item };
    }
    return null;
  }
  private pump(): void {
    while (this.running < this.concurrency) {
      const item = this.next();
      if (!item) break;
      this.running++;
      void (async () => {
        try {
          await item.job();
        } catch (err) {
          console.error("[later] background job failed:", err);
        } finally {
          this.running--;
          this.ids.delete(item.id);
          const n = this.sizeFor(item.key) - 1;
          if (n > 0) this.perKey.set(item.key, n);
          else this.perKey.delete(item.key);
          this.pump();
          if (this.size === 0) for (const r of this.idle.splice(0)) r();
        }
      })();
    }
  }
}

/** Fetch+extract one pending imported article in the background (idempotent per article id). */
export function enqueueCapture(
  queue: TaskQueue,
  repo: Repo,
  extract: Extractor,
  userId: string,
  id: string,
  url: string,
): boolean {
  return queue.push(userId, id, async () => {
    let ex: Extracted | null = null;
    let error: string | null = null;
    try {
      ex = await extract.fetchAndExtract(url);
    } catch (err) {
      error = errMessage(err);
    }
    repo.replaceContent(userId, id, ex, error);
  });
}

/** Re-enqueue every article left "pending" (e.g. by a restart mid-import). Returns how many were queued. */
export function resumePending(queue: TaskQueue, repo: Repo, extract: Extractor): number {
  let n = 0;
  for (const p of repo.listPending()) if (enqueueCapture(queue, repo, extract, p.userId, p.id, p.url)) n++;
  return n;
}

/** Max items accepted from one import upload. */
export const MAX_IMPORT_ITEMS = 5000;
/** Max articles a user may have waiting for background capture. */
export const MAX_PENDING_PER_USER = 5000;

const IMPORT_FORMATS: readonly ImportFormat[] = ["pocket", "omnivore", "instapaper", "readwise", "bookmarks"];
/** Max decompressed bytes read out of an uploaded zip (measured on actual inflated output). */
export const MAX_UNZIPPED = 30 * 1024 * 1024;
/** Max entries (of any kind) in an uploaded zip. */
export const MAX_ZIP_ENTRIES = 1000;
const OMNIVORE_META = /(?:^|\/)metadata_[^/]*\.json$/i;
/** Compressed bytes fed to the inflater per step (bounds a single inflate burst to ~1032x this). */
const ZIP_STEP = 16 * 1024;

class ZipLimit extends Error {}

/**
 * Stream-unzip an Omnivore export, decompressing only metadata_*.json entries. Aborts with 413 once
 * total inflated output exceeds MAX_UNZIPPED or the archive has more than MAX_ZIP_ENTRIES entries.
 */
export function unzipOmnivore(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let total = 0;
  let entries = 0;
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (f) => {
    if (++entries > MAX_ZIP_ENTRIES) throw new ZipLimit(`zip has more than ${MAX_ZIP_ENTRIES} entries`);
    if (!OMNIVORE_META.test(f.name) || f.name.startsWith("__MACOSX/")) return;
    const chunks: Uint8Array[] = [];
    f.ondata = (err, data, final) => {
      if (err) throw err;
      total += data.length;
      if (total > MAX_UNZIPPED) throw new ZipLimit("zip contents too large");
      chunks.push(data);
      if (final) out.set(f.name, Buffer.concat(chunks));
    };
    f.start();
  };
  try {
    if (bytes.length === 0) uz.push(bytes, true);
    for (let i = 0; i < bytes.length; i += ZIP_STEP)
      uz.push(bytes.subarray(i, i + ZIP_STEP), i + ZIP_STEP >= bytes.length);
  } catch (err) {
    if (err instanceof ZipLimit) throw new HTTPException(413, { message: err.message });
    badRequest("invalid zip file");
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function resolveFormat(requested: ImportFormat | "auto", filename: string, text: string): ImportFormat {
  if (requested !== "auto") return requested;
  const f = detectFormat(filename, text);
  if (!f) badRequest("could not detect import format; pass ?format=");
  return f;
}

function parseOrThrow(format: ImportFormat, text: string): ImportItem[] {
  try {
    return parseImport(format, text);
  } catch (err) {
    badRequest(`could not parse ${format} export: ${errMessage(err)}`);
  }
}

/** Parse an uploaded export (raw text or zip) into import items. */
export function parseUpload(
  bytes: Uint8Array,
  filename: string,
  requested: ImportFormat | "auto",
): ImportItem[] {
  if (!isZip(bytes)) {
    const text = decodeText(bytes);
    return parseOrThrow(resolveFormat(requested, filename, text), text);
  }
  if (requested !== "auto" && requested !== "omnivore")
    badRequest(`zip uploads are only supported for omnivore exports`);
  const files = unzipOmnivore(bytes);
  if (!files.size) badRequest("zip contains no Omnivore metadata_*.json files");
  // Omnivore export: concatenate the metadata_*.json arrays.
  const records: unknown[] = [];
  for (const n of [...files.keys()].sort()) {
    let arr: unknown;
    try {
      arr = JSON.parse(decodeText(files.get(n) as Uint8Array));
    } catch {
      badRequest(`invalid JSON in ${n}`);
    }
    if (!Array.isArray(arr)) badRequest(`${n} is not a JSON array`);
    if (records.length + arr.length > MAX_IMPORT_ITEMS)
      badRequest(`too many items in one import (max ${MAX_IMPORT_ITEMS})`);
    records.push(...arr);
  }
  return parseOrThrow("omnivore", JSON.stringify(records));
}

async function readUpload(c: Context<AppEnv>): Promise<{ bytes: Uint8Array; filename: string }> {
  const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct === "multipart/form-data") {
    let form: Record<string, unknown>;
    try {
      form = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      badRequest("invalid multipart body");
    }
    const file = form.file;
    if (file instanceof File) return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
    if (typeof file === "string") return { bytes: new TextEncoder().encode(file), filename: "" };
    badRequest('multipart body must include a "file" field');
  }
  const filename = (c.req.query("filename") ?? "").slice(0, 300);
  return { bytes: new Uint8Array(await c.req.arrayBuffer()), filename };
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Build Extracted from export-provided HTML (sanitized); null if it has no text. */
function extractedFromImport(url: string, title: string, html: string): Extracted | null {
  const clean = sanitizeHtml(html, url);
  const text = htmlToText(clean);
  if (!text.trim()) return null;
  return {
    url,
    title,
    author: null,
    siteName: null,
    excerpt: text.slice(0, 280) || null,
    contentHtml: clean,
    textContent: text,
    wordCount: countWords(text),
    leadImage: null,
    publishedAt: null,
  };
}

/** RFC 6266 Content-Disposition: ASCII fallback + UTF-8 filename*. */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "article"
  );
}

/** Max articles per Obsidian sync page. */
export const SYNC_PAGE = 200;

function encodeSyncCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`, "utf8").toString("base64url");
}

/** Opaque (updatedAt, id) cursor; null if `s` is not one (e.g. a plain ISO date). */
function decodeSyncCursor(s: string): { updatedAt: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const d = Buffer.from(s, "base64url").toString("utf8");
  const i = d.lastIndexOf("|");
  if (i <= 0) return null;
  const updatedAt = d.slice(0, i);
  if (Number.isNaN(Date.parse(updatedAt))) return null;
  return { updatedAt, id: d.slice(i + 1) };
}

const today = () => new Date().toISOString().slice(0, 10);
const MAX_EPUB_IDS = 100;

function bytesResponse(c: Context, bytes: Uint8Array, type: string, filename: string): Response {
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": type,
    "Content-Disposition": attachment(filename),
    "Cache-Control": "no-store",
  });
}

export function ioRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const kindleLimiter = new RateLimiter(30, 60 * 60_000);

  r.post("/import", requireAuth, async (c) => {
    const fmtRaw = (c.req.query("format") ?? "auto").toLowerCase();
    if (fmtRaw !== "auto" && !(IMPORT_FORMATS as readonly string[]).includes(fmtRaw))
      badRequest(`format must be one of ${IMPORT_FORMATS.join(", ")} or auto`);
    const { bytes, filename } = await readUpload(c);
    if (!bytes.length) badRequest("empty upload");
    const items = parseUpload(bytes, filename, fmtRaw as ImportFormat | "auto");
    if (items.length > MAX_IMPORT_ITEMS) badRequest(`too many items in one import (max ${MAX_IMPORT_ITEMS})`);

    const repo = c.get("repo");
    const queue = c.get("queue");
    const extract = c.get("deps").extract;
    const userId = c.get("user").id;
    // Admission control: bound the background capture backlog per user (counted conservatively:
    // every item in this upload may become pending).
    const backlog = Math.max(repo.countPending(userId), queue.sizeFor(userId));
    if (backlog + items.length > MAX_PENDING_PER_USER)
      throw new HTTPException(429, {
        message: `too many articles awaiting capture (${backlog}); try again after they finish`,
      });
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const toFetch: { id: string; url: string }[] = [];
    // Synchronous: the duplicate check and insert cannot interleave with other requests.
    for (const item of items) {
      const url = normalizeUrl(item.url);
      if (!url) {
        failed++;
        continue;
      }
      if (repo.findArticleByUrl(userId, url)) {
        skipped++;
        continue;
      }
      const title = (item.title ?? "").trim().slice(0, 1000) || null;
      const extracted = item.contentHtml ? extractedFromImport(url, title ?? "", item.contentHtml) : null;
      const a = repo.saveArticle(userId, extracted, {
        url,
        source: "import",
        title,
        tags: normalizeTags(item.tags),
        savedAt: isoOrNull(item.savedAt),
        state: item.state === "archived" ? "archived" : "inbox",
        favorite: item.favorite === true,
        pending: true,
      });
      for (const h of item.highlights) {
        if (typeof h.quote !== "string" || !h.quote.trim()) continue;
        repo.createHighlight(userId, a.id, {
          quote: h.quote.slice(0, 20_000),
          note: h.note ? h.note.slice(0, 20_000) : null,
          createdAt: isoOrNull(h.createdAt),
        });
      }
      imported++;
      if (a.captureStatus === "pending") toFetch.push({ id: a.id, url });
    }
    for (const { id, url } of toFetch) enqueueCapture(queue, repo, extract, userId, id, url);
    return c.json({ imported, skipped, failed });
  });

  r.get("/export.json", requireAuth, (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const bundle: ExportBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      articles: repo.allArticles(userId),
      highlights: repo.allHighlights(userId),
      feeds: repo.listFeeds(userId),
    };
    return c.body(exportJson(bundle), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": attachment(`later-export-${today()}.json`),
      "Cache-Control": "no-store",
    });
  });

  r.get("/export.md.zip", requireAuth, (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const byArticle = new Map<string, ReturnType<typeof repo.allHighlights>>();
    for (const h of repo.allHighlights(userId)) {
      const list = byArticle.get(h.articleId) ?? [];
      list.push(h);
      byArticle.set(h.articleId, list);
    }
    const used = new Set<string>();
    const files = repo.allArticles(userId).map((a) => {
      const f = articleToMarkdown(a, byArticle.get(a.id) ?? []);
      let path = f.path;
      for (let i = 2; used.has(path.toLowerCase()); i++) path = f.path.replace(/\.md$/, `-${i}.md`);
      used.add(path.toLowerCase());
      return { path, markdown: f.markdown };
    });
    return bytesResponse(c, markdownZip(files), "application/zip", `later-markdown-${today()}.zip`);
  });

  r.get("/articles/:id/epub", requireAuth, (c) => {
    const a = c.get("repo").getArticle(c.get("user").id, c.req.param("id"));
    if (!a) throw new HTTPException(404, { message: "article not found" });
    return bytesResponse(
      c,
      buildEpub([a], { title: a.title }),
      "application/epub+zip",
      `${slug(a.title)}.epub`,
    );
  });

  r.get("/export.epub", requireAuth, (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const idsRaw = c.req.query("ids");
    let ids: string[];
    if (idsRaw) {
      ids = [
        ...new Set(
          idsRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length > MAX_EPUB_IDS) badRequest(`at most ${MAX_EPUB_IDS} ids`);
    } else {
      ids = repo.listArticles(userId, { state: "inbox", limit: 20 }).items.map((a) => a.id);
    }
    const articles = ids.map((id) => repo.getArticle(userId, id)).filter((a): a is Article => a !== null);
    if (!articles.length) throw new HTTPException(404, { message: "no articles to export" });
    const title = `Later — ${today()}`;
    return bytesResponse(c, buildEpub(articles, { title }), "application/epub+zip", `later-${today()}.epub`);
  });

  r.post("/articles/:id/kindle", requireAuth, async (c) => {
    const user = c.get("user");
    const deps = c.get("deps");
    const a = c.get("repo").getArticle(user.id, c.req.param("id"));
    if (!a) throw new HTTPException(404, { message: "article not found" });
    if (!user.kindleEmail) badRequest("set your Kindle email in settings first");
    if (!deps.config.smtpUrl)
      throw new HTTPException(501, { message: "email sending is not configured (SMTP_URL)" });
    if (!kindleLimiter.attempt(user.id))
      throw new HTTPException(429, { message: "too many Kindle sends; try later" });
    deps.mailer ??= createSmtpMailer(deps.config.smtpUrl);
    const epub = buildEpub([a], { title: a.title });
    try {
      await deps.mailer.send({
        from: deps.config.mailFrom || defaultMailFrom(deps.config.publicUrl),
        to: user.kindleEmail,
        subject: a.title.replace(/[\r\n]+/g, " ").slice(0, 200) || "Later article",
        text: `Sent from Later: ${a.url || a.title}`,
        attachments: [
          { filename: `${slug(a.title)}.epub`, content: epub, contentType: "application/epub+zip" },
        ],
      });
    } catch (err) {
      console.error("[later] kindle send failed:", errMessage(err));
      throw new HTTPException(502, { message: "sending to Kindle failed" });
    }
    return c.json({ ok: true }, 202);
  });

  r.get("/obsidian/sync", requireAuth, (c) => {
    // `since` is either an ISO date (strictly-after) or an opaque cursor returned by this endpoint.
    const sinceRaw = c.req.query("cursor") || c.req.query("since");
    let after: { updatedAt: string; id: string | null } | null = null;
    if (sinceRaw) {
      const cur = decodeSyncCursor(sinceRaw);
      if (cur) after = cur;
      else {
        const t = Date.parse(sinceRaw);
        if (Number.isNaN(t)) badRequest("since must be an ISO date or a cursor");
        after = { updatedAt: new Date(t).toISOString(), id: null };
      }
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : SYNC_PAGE;
    if (!Number.isInteger(limit) || limit < 1) badRequest("limit must be a positive integer");
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const page = repo.articlesUpdatedSince(userId, after, Math.min(limit, SYNC_PAGE));
    const last = page.items[page.items.length - 1];
    const cursor = last
      ? encodeSyncCursor(last.updatedAt, last.id)
      : after
        ? after.id === null
          ? after.updatedAt
          : encodeSyncCursor(after.updatedAt, after.id)
        : null;
    const articles = page.items.map((a) => articleToMarkdown(a, repo.listHighlights(userId, a.id)));
    return c.json({ articles, cursor, nextCursor: page.more ? cursor : null });
  });

  return r;
}
