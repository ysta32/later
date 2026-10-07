import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { unzipSync } from "fflate";
import type { Article, ExportBundle, Extracted, ImportFormat, ImportItem } from "@later/core";
import { detectFormat, parseImport } from "@later/core/importers";
import { articleToMarkdown, exportJson, markdownZip } from "../../../../packages/core/src/exporters.ts"; // switch to "@later/core/exporters" once t03 lands
import { buildEpub } from "../../../../packages/core/src/epub.ts"; // switch to "@later/core/epub" once t03 lands
import { countWords, htmlToText, sanitizeHtml } from "@later/core/sanitize";
import { badRequest, requireAuth, type AppEnv } from "../app.ts";
import { RateLimiter } from "../auth.ts";
import { createSmtpMailer, defaultMailFrom } from "../mailer.ts";
import { normalizeTags } from "../repo.ts";
import { normalizeUrl } from "./articles.ts";
import { errMessage } from "./channels.ts";

/** Minimal in-process job queue with bounded concurrency. Job errors are logged, never thrown. */
export class TaskQueue {
  private readonly concurrency: number;
  private readonly jobs: (() => Promise<void>)[] = [];
  private running = 0;
  private idle: (() => void)[] = [];
  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }
  get size(): number {
    return this.jobs.length + this.running;
  }
  push(job: () => Promise<void>): void {
    this.jobs.push(job);
    this.pump();
  }
  /** Resolves when no jobs are queued or running. */
  drain(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
  private pump(): void {
    while (this.running < this.concurrency && this.jobs.length) {
      const job = this.jobs.shift() as () => Promise<void>;
      this.running++;
      void (async () => {
        try {
          await job();
        } catch (err) {
          console.error("[later] background job failed:", err);
        } finally {
          this.running--;
          this.pump();
          if (this.size === 0) for (const r of this.idle.splice(0)) r();
        }
      })();
    }
  }
}

const IMPORT_FORMATS: readonly ImportFormat[] = ["pocket", "omnivore", "instapaper", "readwise", "bookmarks"];
/** Total decompressed bytes we are willing to read out of an uploaded zip. */
const MAX_UNZIPPED = 200 * 1024 * 1024;
const DATA_FILE = /\.(json|csv|html?|txt)$/i;
const OMNIVORE_META = /(?:^|\/)metadata_[^/]*\.json$/i;

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
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!DATA_FILE.test(f.name) || f.name.startsWith("__MACOSX/")) return false;
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new RangeError("zip contents too large");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof RangeError) throw new HTTPException(413, { message: "zip contents too large" });
    badRequest("invalid zip file");
  }
  const names = Object.keys(files).sort();
  const meta = names.filter((n) => OMNIVORE_META.test(n));
  if (meta.length && (requested === "auto" || requested === "omnivore")) {
    // Omnivore export: concatenate the metadata_*.json arrays.
    const records: unknown[] = [];
    for (const n of meta) {
      let arr: unknown;
      try {
        arr = JSON.parse(decodeText(files[n]));
      } catch {
        badRequest(`invalid JSON in ${n}`);
      }
      if (Array.isArray(arr)) records.push(...arr);
    }
    return parseOrThrow("omnivore", JSON.stringify(records));
  }
  const items: ImportItem[] = [];
  for (const n of names) {
    const text = decodeText(files[n]);
    const format = requested === "auto" ? detectFormat(n, text) : requested;
    if (!format) continue;
    items.push(...parseOrThrow(format, text));
  }
  if (!items.length && names.length && requested === "auto")
    badRequest("could not detect import format in zip");
  return items;
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

    const repo = c.get("repo");
    const queue = c.get("queue");
    const extract = c.get("deps").extract;
    const userId = c.get("user").id;
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
    for (const { id, url } of toFetch) {
      queue.push(async () => {
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
    const sinceRaw = c.req.query("since");
    let since: string | null = null;
    if (sinceRaw) {
      const t = Date.parse(sinceRaw);
      if (Number.isNaN(t)) badRequest("since must be an ISO date");
      since = new Date(t).toISOString();
    }
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const arts = repo.articlesUpdatedSince(userId, since);
    let cursor = since;
    const articles = arts.map((a) => {
      if (!cursor || a.updatedAt > cursor) cursor = a.updatedAt;
      return articleToMarkdown(a, repo.listHighlights(userId, a.id));
    });
    return c.json({ articles, cursor });
  });

  return r;
}
