import { randomBytes } from "node:crypto";
import { newId } from "@later/core";
import type { Article, ArticleState, CaptureSource, Extracted, Highlight, User } from "@later/core";
import { tx, type Db } from "./db.ts";
import { hashToken, newToken, SESSION_DAYS } from "./auth.ts";

type Row = Record<string, unknown>;

export type SessionKind = "session" | "api";
export type HighlightColor = Highlight["color"];
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink"];
export const CAPTURE_SOURCES: readonly CaptureSource[] = [
  "server",
  "extension",
  "bookmarklet",
  "share",
  "email",
  "rss",
  "import",
  "api",
];

export interface ListFilters {
  state?: ArticleState | "all";
  tag?: string;
  favorite?: boolean;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SaveOptions {
  url: string;
  source: CaptureSource;
  tags?: string[];
  captureError?: string | null;
  /** Fallback/override title (used when extraction failed or yielded no title). */
  title?: string | null;
  savedAt?: string | null;
  state?: ArticleState;
  favorite?: boolean;
}

export interface ArticlePatch {
  state?: ArticleState;
  favorite?: boolean;
  progress?: number;
  title?: string;
  tags?: string[];
  summary?: string | null;
}

export interface HighlightInput {
  quote: string;
  prefix?: string;
  suffix?: string;
  note?: string | null;
  color?: HighlightColor;
  createdAt?: string | null;
}

export type SearchHit = Article & { snippet: string };
export type HighlightWithArticle = Highlight & { articleTitle: string; articleUrl: string };

const nowIso = () => new Date().toISOString();

/** Normalize a tag list: trim, drop empties, cap length, dedupe case-insensitively. */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/\s+/g, " ").slice(0, 64);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= 50) break;
  }
  return out;
}

/** Fallback title from a URL: hostname + path. */
export function urlTitle(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return (u.hostname + path).slice(0, 300) || url;
  } catch {
    return url || "Untitled";
  }
}

/**
 * Turn arbitrary user input into a safe FTS5 query: every word becomes a quoted
 * phrase token (implicit AND), the last one a prefix query. Returns null if nothing searchable.
 */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return null;
  const toks = words.slice(0, 16).map((w) => `"${w}"`);
  toks[toks.length - 1] += "*";
  return toks.join(" ");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

function encodeCursor(savedAt: string, id: string): string {
  return Buffer.from(`${savedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { savedAt: string; id: string } | null {
  try {
    const s = Buffer.from(cursor, "base64url").toString("utf8");
    const i = s.lastIndexOf("|");
    if (i <= 0) return null;
    return { savedAt: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

function rowToUser(r: Row): User {
  return {
    id: str(r.id),
    email: str(r.email),
    createdAt: str(r.created_at),
    inboundToken: str(r.inbound_token),
    kindleEmail: strOrNull(r.kindle_email),
  };
}

function rowToArticle(r: Row, tags: string[]): Article {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    url: str(r.url),
    title: str(r.title),
    author: strOrNull(r.author),
    siteName: strOrNull(r.site_name),
    excerpt: strOrNull(r.excerpt),
    contentHtml: str(r.content_html),
    textContent: str(r.text_content),
    wordCount: Number(r.word_count ?? 0),
    leadImage: strOrNull(r.lead_image),
    publishedAt: strOrNull(r.published_at),
    savedAt: str(r.saved_at),
    updatedAt: str(r.updated_at),
    state: r.state === "archived" ? "archived" : "inbox",
    favorite: Number(r.favorite) === 1,
    progress: Number(r.progress ?? 0),
    source: str(r.source) as CaptureSource,
    captureStatus: (str(r.capture_status) || "ok") as Article["captureStatus"],
    captureError: strOrNull(r.capture_error),
    tags,
    summary: strOrNull(r.summary),
  };
}

function rowToHighlight(r: Row): Highlight {
  return {
    id: str(r.id),
    articleId: str(r.article_id),
    userId: str(r.user_id),
    quote: str(r.quote),
    prefix: str(r.prefix),
    suffix: str(r.suffix),
    note: strOrNull(r.note),
    color: (HIGHLIGHT_COLORS as readonly string[]).includes(str(r.color))
      ? (str(r.color) as HighlightColor)
      : "yellow",
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

/** Columns for list views (contentHtml blanked). */
const LIST_COLS = `a.id, a.user_id, a.url, a.title, a.author, a.site_name, a.excerpt, '' AS content_html, a.text_content,
  a.word_count, a.lead_image, a.published_at, a.saved_at, a.updated_at, a.state, a.favorite, a.progress, a.source,
  a.capture_status, a.capture_error, a.summary`;

/**
 * Data access layer. Every article/highlight/session method takes the acting userId and
 * scopes its SQL by it, so callers cannot reach other users' rows (no IDOR).
 */
export class Repo {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  // ---------- users ----------
  countUsers(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row;
    return Number(r.n);
  }

  createUser(email: string, passwordHash: string): User {
    const id = newId();
    const created = nowIso();
    const inbound = randomBytes(9).toString("hex");
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at, inbound_token) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, email, passwordHash, created, inbound);
    return { id, email, createdAt: created, inboundToken: inbound, kindleEmail: null };
  }

  getUser(id: string): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToUser(r) : null;
  }

  getUserByEmail(email: string): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Row | undefined;
    return r ? rowToUser(r) : null;
  }

  getUserByInboundToken(token: string): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE inbound_token = ?").get(token) as Row | undefined;
    return r ? rowToUser(r) : null;
  }

  getPasswordHash(userId: string): string | null {
    const r = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as Row | undefined;
    return r ? str(r.password_hash) : null;
  }

  updateUser(userId: string, patch: { kindleEmail?: string | null }): User | null {
    if (patch.kindleEmail !== undefined) {
      this.db.prepare("UPDATE users SET kindle_email = ? WHERE id = ?").run(patch.kindleEmail, userId);
    }
    return this.getUser(userId);
  }

  // ---------- sessions / API tokens ----------
  createSession(userId: string, kind: SessionKind, label?: string | null): string {
    const token = newToken();
    const created = nowIso();
    const expires = kind === "session" ? new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() : null;
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, kind, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(hashToken(token), userId, kind, label ?? null, created, expires);
    return token;
  }

  userForToken(token: string): User | null {
    if (!token) return null;
    const r = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND (s.expires_at IS NULL OR s.expires_at > ?)`,
      )
      .get(hashToken(token), nowIso()) as Row | undefined;
    return r ? rowToUser(r) : null;
  }

  sessionKind(token: string): SessionKind | null {
    const r = this.db.prepare("SELECT kind FROM sessions WHERE token_hash = ?").get(hashToken(token)) as
      Row | undefined;
    return r ? (str(r.kind) as SessionKind) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  pruneSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?").run(nowIso());
  }

  // ---------- articles ----------
  private tagsFor(articleIds: string[]): Map<string, string[]> {
    const m = new Map<string, string[]>();
    if (articleIds.length === 0) return m;
    const rows = this.db
      .prepare(
        "SELECT article_id, tag FROM article_tags WHERE article_id IN (SELECT value FROM json_each(?)) ORDER BY tag COLLATE NOCASE",
      )
      .all(JSON.stringify(articleIds)) as Row[];
    for (const r of rows) {
      const id = str(r.article_id);
      const list = m.get(id) ?? [];
      list.push(str(r.tag));
      m.set(id, list);
    }
    return m;
  }

  private hydrate(rows: Row[]): Article[] {
    const tags = this.tagsFor(rows.map((r) => str(r.id)));
    return rows.map((r) => rowToArticle(r, tags.get(str(r.id)) ?? []));
  }

  getArticle(userId: string, id: string): Article | null {
    const r = this.db.prepare("SELECT * FROM articles WHERE id = ? AND user_id = ?").get(id, userId) as
      Row | undefined;
    return r ? this.hydrate([r])[0] : null;
  }

  findArticleByUrl(userId: string, url: string): Article | null {
    if (!url) return null;
    const r = this.db.prepare("SELECT * FROM articles WHERE user_id = ? AND url = ?").get(userId, url) as
      Row | undefined;
    return r ? this.hydrate([r])[0] : null;
  }

  /**
   * Upsert by (user, url). `extracted === null` means capture failed: a new article is stored with
   * captureStatus "failed"; an existing successfully-captured article keeps its content.
   * Tags are merged (never dropped) on re-save.
   */
  saveArticle(userId: string, extracted: Extracted | null, opts: SaveOptions): Article {
    return tx(this.db, () => {
      const now = nowIso();
      const existing = opts.url ? this.findArticleByUrl(userId, opts.url) : null;
      let id: string;
      if (existing) {
        id = existing.id;
        if (extracted) {
          this.db
            .prepare(
              `UPDATE articles SET title = ?, author = ?, site_name = ?, excerpt = ?, content_html = ?, text_content = ?,
                 word_count = ?, lead_image = ?, published_at = ?, updated_at = ?, source = ?, capture_status = 'ok', capture_error = NULL
               WHERE id = ? AND user_id = ?`,
            )
            .run(
              extracted.title || opts.title || existing.title,
              extracted.author,
              extracted.siteName,
              extracted.excerpt,
              extracted.contentHtml,
              extracted.textContent,
              extracted.wordCount,
              extracted.leadImage,
              extracted.publishedAt,
              now,
              opts.source,
              id,
              userId,
            );
        } else if (existing.captureStatus !== "ok") {
          this.db
            .prepare(
              "UPDATE articles SET capture_status = 'failed', capture_error = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            )
            .run(opts.captureError ?? "capture failed", now, id, userId);
        }
      } else {
        id = newId();
        const title = (extracted?.title || opts.title || urlTitle(opts.url)).slice(0, 1000);
        this.db
          .prepare(
            `INSERT INTO articles (id, user_id, url, title, author, site_name, excerpt, content_html, text_content, word_count,
               lead_image, published_at, saved_at, updated_at, state, favorite, progress, source, capture_status, capture_error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            id,
            userId,
            opts.url,
            title,
            extracted?.author ?? null,
            extracted?.siteName ?? null,
            extracted?.excerpt ?? null,
            extracted?.contentHtml ?? "",
            extracted?.textContent ?? "",
            extracted?.wordCount ?? 0,
            extracted?.leadImage ?? null,
            extracted?.publishedAt ?? null,
            opts.savedAt || now,
            now,
            opts.state ?? "inbox",
            opts.favorite ? 1 : 0,
            opts.source,
            extracted ? "ok" : "failed",
            extracted ? null : (opts.captureError ?? "capture failed"),
          );
      }
      if (opts.tags && opts.tags.length) {
        const merged = normalizeTags([...(existing?.tags ?? []), ...opts.tags]);
        this.setTags(userId, id, merged);
      }
      return this.getArticle(userId, id) as Article;
    });
  }

  listArticles(userId: string, f: ListFilters = {}): { items: Article[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50) || 50, 1), 200);
    const where: string[] = ["a.user_id = ?"];
    const params: (string | number)[] = [userId];
    if (f.state && f.state !== "all") {
      where.push("a.state = ?");
      params.push(f.state);
    }
    if (f.favorite) where.push("a.favorite = 1");
    if (f.tag) {
      where.push("EXISTS (SELECT 1 FROM article_tags t WHERE t.article_id = a.id AND t.tag = ?)");
      params.push(f.tag);
    }
    if (f.q) {
      const m = ftsQuery(f.q);
      if (m) {
        where.push("a.rowid IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)");
        params.push(m);
      }
    }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      if (!c) throw new RangeError("invalid cursor");
      where.push("(a.saved_at < ? OR (a.saved_at = ? AND a.id < ?))");
      params.push(c.savedAt, c.savedAt, c.id);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLS} FROM articles a WHERE ${where.join(" AND ")} ORDER BY a.saved_at DESC, a.id DESC LIMIT ?`,
      )
      .all(...params) as Row[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const items = this.hydrate(page);
    const last = items[items.length - 1];
    return { items, nextCursor: more && last ? encodeCursor(last.savedAt, last.id) : null };
  }

  updateArticle(userId: string, id: string, patch: ArticlePatch): Article | null {
    return tx(this.db, () => {
      if (!this.getArticle(userId, id)) return null;
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.state !== undefined) {
        sets.push("state = ?");
        params.push(patch.state);
      }
      if (patch.favorite !== undefined) {
        sets.push("favorite = ?");
        params.push(patch.favorite ? 1 : 0);
      }
      if (patch.progress !== undefined) {
        sets.push("progress = ?");
        params.push(Math.min(1, Math.max(0, patch.progress)));
      }
      if (patch.title !== undefined) {
        sets.push("title = ?");
        params.push(patch.title);
      }
      if (patch.summary !== undefined) {
        sets.push("summary = ?");
        params.push(patch.summary);
      }
      sets.push("updated_at = ?");
      params.push(nowIso());
      this.db
        .prepare(`UPDATE articles SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
        .run(...params, id, userId);
      if (patch.tags !== undefined) this.setTags(userId, id, patch.tags);
      return this.getArticle(userId, id);
    });
  }

  /** Replace an article's content after a (re)fetch. */
  replaceContent(
    userId: string,
    id: string,
    extracted: Extracted | null,
    captureError?: string | null,
  ): Article | null {
    const a = this.getArticle(userId, id);
    if (!a) return null;
    if (extracted) {
      this.db
        .prepare(
          `UPDATE articles SET title = ?, author = ?, site_name = ?, excerpt = ?, content_html = ?, text_content = ?,
             word_count = ?, lead_image = ?, published_at = ?, updated_at = ?, capture_status = 'ok', capture_error = NULL
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          extracted.title || a.title,
          extracted.author,
          extracted.siteName,
          extracted.excerpt,
          extracted.contentHtml,
          extracted.textContent,
          extracted.wordCount,
          extracted.leadImage,
          extracted.publishedAt,
          nowIso(),
          id,
          userId,
        );
    } else if (a.captureStatus !== "ok") {
      this.db
        .prepare(
          "UPDATE articles SET capture_status = 'failed', capture_error = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .run(captureError ?? "capture failed", nowIso(), id, userId);
    }
    return this.getArticle(userId, id);
  }

  deleteArticle(userId: string, id: string): boolean {
    const r = this.db.prepare("DELETE FROM articles WHERE id = ? AND user_id = ?").run(id, userId);
    return Number(r.changes) > 0;
  }

  setTags(userId: string, articleId: string, tags: string[]): boolean {
    return tx(this.db, () => {
      const owned = this.db
        .prepare("SELECT 1 FROM articles WHERE id = ? AND user_id = ?")
        .get(articleId, userId);
      if (!owned) return false;
      this.db.prepare("DELETE FROM article_tags WHERE article_id = ?").run(articleId);
      const ins = this.db.prepare("INSERT OR IGNORE INTO article_tags (article_id, tag) VALUES (?, ?)");
      for (const t of normalizeTags(tags)) ins.run(articleId, t);
      return true;
    });
  }

  tagCounts(userId: string): { tag: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(t.tag) AS tag, COUNT(*) AS count FROM article_tags t JOIN articles a ON a.id = t.article_id
         WHERE a.user_id = ? GROUP BY t.tag COLLATE NOCASE ORDER BY count DESC, tag COLLATE NOCASE`,
      )
      .all(userId) as Row[];
    return rows.map((r) => ({ tag: str(r.tag), count: Number(r.count) }));
  }

  /** FTS5 search; the snippet is HTML-escaped with matches wrapped in <mark>. */
  search(userId: string, q: string, limit = 50): SearchHit[] {
    const m = ftsQuery(q);
    if (!m) return [];
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLS}, snippet(articles_fts, -1, ?, ?, '…', 16) AS snippet
         FROM articles_fts JOIN articles a ON a.rowid = articles_fts.rowid
         WHERE articles_fts MATCH ? AND a.user_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(MARK_OPEN, MARK_CLOSE, m, userId, Math.min(Math.max(limit, 1), 200)) as Row[];
    const arts = this.hydrate(rows);
    return arts.map((a, i) => ({
      ...a,
      // escapeHtml leaves the control-char markers intact; only they become <mark> tags.
      snippet: escapeHtml(str(rows[i].snippet))
        .replaceAll(MARK_OPEN, "<mark>")
        .replaceAll(MARK_CLOSE, "</mark>"),
    }));
  }

  allArticles(userId: string): Article[] {
    const rows = this.db
      .prepare("SELECT * FROM articles WHERE user_id = ? ORDER BY saved_at DESC, id DESC")
      .all(userId) as Row[];
    return this.hydrate(rows);
  }

  // ---------- highlights ----------
  listHighlights(userId: string, articleId: string): Highlight[] {
    const rows = this.db
      .prepare("SELECT * FROM highlights WHERE user_id = ? AND article_id = ? ORDER BY created_at, id")
      .all(userId, articleId) as Row[];
    return rows.map(rowToHighlight);
  }

  getHighlight(userId: string, id: string): Highlight | null {
    const r = this.db.prepare("SELECT * FROM highlights WHERE id = ? AND user_id = ?").get(id, userId) as
      Row | undefined;
    return r ? rowToHighlight(r) : null;
  }

  /** Returns null if the article does not exist or belongs to someone else. */
  createHighlight(userId: string, articleId: string, h: HighlightInput): Highlight | null {
    return tx(this.db, () => {
      const owned = this.db
        .prepare("SELECT 1 FROM articles WHERE id = ? AND user_id = ?")
        .get(articleId, userId);
      if (!owned) return null;
      const id = newId();
      const created = h.createdAt || nowIso();
      this.db
        .prepare(
          `INSERT INTO highlights (id, article_id, user_id, quote, prefix, suffix, note, color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          articleId,
          userId,
          h.quote,
          (h.prefix ?? "").slice(-32),
          (h.suffix ?? "").slice(0, 32),
          h.note ?? null,
          h.color ?? "yellow",
          created,
          created,
        );
      return this.getHighlight(userId, id);
    });
  }

  updateHighlight(
    userId: string,
    id: string,
    patch: { note?: string | null; color?: HighlightColor },
  ): Highlight | null {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (patch.note !== undefined) {
      sets.push("note = ?");
      params.push(patch.note);
    }
    if (patch.color !== undefined) {
      sets.push("color = ?");
      params.push(patch.color);
    }
    sets.push("updated_at = ?");
    params.push(nowIso());
    const r = this.db
      .prepare(`UPDATE highlights SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .run(...params, id, userId);
    return Number(r.changes) > 0 ? this.getHighlight(userId, id) : null;
  }

  deleteHighlight(userId: string, id: string): boolean {
    const r = this.db.prepare("DELETE FROM highlights WHERE id = ? AND user_id = ?").run(id, userId);
    return Number(r.changes) > 0;
  }

  listAllHighlights(userId: string): HighlightWithArticle[] {
    const rows = this.db
      .prepare(
        `SELECT h.*, a.title AS article_title, a.url AS article_url FROM highlights h
         JOIN articles a ON a.id = h.article_id AND a.user_id = h.user_id
         WHERE h.user_id = ? ORDER BY h.created_at DESC, h.id DESC`,
      )
      .all(userId) as Row[];
    return rows.map((r) => ({
      ...rowToHighlight(r),
      articleTitle: str(r.article_title),
      articleUrl: str(r.article_url),
    }));
  }

  allHighlights(userId: string): Highlight[] {
    const rows = this.db
      .prepare("SELECT * FROM highlights WHERE user_id = ? ORDER BY created_at, id")
      .all(userId) as Row[];
    return rows.map(rowToHighlight);
  }
}
