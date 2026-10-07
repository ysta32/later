import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Extracted, Feed } from "@later/core";
import { assertPublicUrl, isPrivateIp, pinnedRequest, type ResolvedAddress } from "@later/core/extract";
import { parseFeed } from "@later/core/feeds";
import { countWords, htmlToText, sanitizeHtml } from "@later/core/sanitize";
import { badRequest, readJson, requireAuth, type AppDeps, type AppEnv } from "../app.ts";
import { RateLimiter } from "../auth.ts";
import type { Repo } from "../repo.ts";
import { normalizeUrl } from "./articles.ts";
import { errMessage } from "./channels.ts";

/** Fetch a feed document as text. */
export type FeedFetcher = (url: string) => Promise<string>;

export const FEED_TIMEOUT_MS = 15_000;
/** Minimum interval between manual refreshes per user. */
export const REFRESH_COOLDOWN_MS = 60_000;
const FEED_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Feed items whose sanitized text exceeds this many chars are stored as-is (no page fetch). */
const SUBSTANTIAL_CHARS = 500;
/** Cap on new items ingested per feed per refresh; further unseen items stay unseen for the next run. */
export const MAX_NEW_PER_REFRESH = 20;
/** Max feeds per user. */
export const MAX_FEEDS_PER_USER = 200;
/** Max feeds being refreshed at once across the whole process (route + scheduler). */
export const FEED_REFRESH_CONCURRENCY = 4;

/** Counting semaphore. */
class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.free = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}
const refreshSlots = new Semaphore(FEED_REFRESH_CONCURRENCY);

const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5";

/**
 * SSRF-guarded feed fetch: every hop (redirects followed manually) must be http(s) and resolve only
 * to public addresses (unless allowPrivate); connections are pinned to the validated addresses
 * (no DNS rebinding). Body capped at 10 MB; whole fetch bounded by `timeoutMs`.
 */
export function createFeedFetcher(opts: { allowPrivate?: boolean; timeoutMs?: number } = {}): FeedFetcher {
  const allowPrivate = opts.allowPrivate === true;
  const timeoutMs = opts.timeoutMs ?? FEED_TIMEOUT_MS;
  return async (startUrl) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = await assertPublicUrl(url, { allowPrivate });
      let addresses: ResolvedAddress[] | null = null;
      const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
      if (!allowPrivate && !isIP(host)) {
        // Resolve once more for pinning and re-check (assertPublicUrl's answer is not returned).
        const addrs = await dnsLookup(host, { all: true, verbatim: true });
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
          throw new Error(`Blocked non-public address for ${host}`);
        addresses = addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
      }
      const res = await pinnedRequest(
        u.href,
        { headers: { Accept: FEED_ACCEPT, "User-Agent": "Later feed reader" }, signal },
        addresses,
      );
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => undefined);
        url = new URL(res.headers.get("location") as string, u).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status} fetching feed`);
      }
      return await readCappedText(res, FEED_MAX_BYTES);
    }
    throw new Error("too many redirects");
  };
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("feed too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("feed fetch timed out")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function fetcherFor(deps: AppDeps): FeedFetcher {
  return deps.fetchFeed ?? createFeedFetcher({ allowPrivate: deps.config.allowPrivateFetch === true });
}

/** Refresh one feed (bounded by the process-wide refresh concurrency). Returns articles added. */
export function refreshFeed(repo: Repo, deps: AppDeps, feed: Feed): Promise<number> {
  return refreshSlots.run(() => refreshFeedNow(repo, deps, feed));
}

async function refreshFeedNow(repo: Repo, deps: AppDeps, feed: Feed): Promise<number> {
  let parsed;
  try {
    const xml = await withTimeout(fetcherFor(deps)(feed.url), FEED_TIMEOUT_MS);
    parsed = parseFeed(xml, feed.url);
  } catch (err) {
    repo.updateFeedFetch(feed.userId, feed.id, { error: errMessage(err) });
    return 0;
  }
  repo.updateFeedFetch(feed.userId, feed.id, { title: parsed.title, error: null });

  let added = 0;
  let fresh = 0;
  for (const item of parsed.items) {
    const guid = (item.guid || item.url || "").slice(0, 2000);
    if (!guid) continue;
    if (repo.isFeedSeen(feed.id, guid)) continue;
    // Over the per-run cap: leave the rest unseen so a later refresh picks them up.
    if (fresh >= MAX_NEW_PER_REFRESH) break;
    // Claim the guid synchronously first so overlapping refreshes never ingest an item twice.
    if (!repo.markFeedSeen(feed.id, guid)) continue;
    fresh++;
    const url = item.url ? normalizeUrl(item.url) : null;
    if (url && repo.findArticleByUrl(feed.userId, url)) continue;

    const title = item.title.trim().slice(0, 1000) || null;
    let extracted: Extracted | null = null;
    let captureError: string | null = null;
    if (item.contentHtml) {
      // Feed HTML is raw/untrusted: always sanitize before storing.
      const html = sanitizeHtml(item.contentHtml, url ?? feed.url);
      const text = htmlToText(html);
      if (text.length > SUBSTANTIAL_CHARS || !url) {
        if (text.trim())
          extracted = {
            url: url ?? "",
            title: title ?? "",
            author: null,
            siteName: parsed.title || null,
            excerpt: text.slice(0, 280) || null,
            contentHtml: html,
            textContent: text,
            wordCount: countWords(text),
            leadImage: null,
            publishedAt: item.publishedAt,
          };
      }
    }
    if (!extracted && url) {
      try {
        extracted = await deps.extract.fetchAndExtract(url);
      } catch (err) {
        captureError = errMessage(err);
      }
    }
    if (!extracted && !url) continue;
    if (!repo.getFeed(feed.userId, feed.id)) break; // unsubscribed meanwhile
    repo.saveArticle(feed.userId, extracted, { url: url ?? "", source: "rss", title, captureError });
    added++;
  }
  return added;
}

/** Refresh all of a user's feeds sequentially. */
export async function refreshUserFeeds(repo: Repo, deps: AppDeps, userId: string): Promise<number> {
  let added = 0;
  for (const feed of repo.listFeeds(userId)) added += await refreshFeed(repo, deps, feed);
  return added;
}

export function feedRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const addLimiter = new RateLimiter(30, 60 * 60_000);
  const refreshCooldown = new RateLimiter(1, REFRESH_COOLDOWN_MS);

  r.get("/feeds", requireAuth, (c) => c.json({ items: c.get("repo").listFeeds(c.get("user").id) }));

  r.post("/feeds", requireAuth, async (c) => {
    const body = await readJson(c);
    const url = normalizeUrl(body.url);
    if (!url) badRequest("a valid http(s) url is required");
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const existing = repo.getFeedByUrl(userId, url);
    if (existing) return c.json(existing, 200);
    if (repo.countFeeds(userId) >= MAX_FEEDS_PER_USER)
      badRequest(`feed limit reached (max ${MAX_FEEDS_PER_USER})`);
    if (!addLimiter.attempt(userId))
      throw new HTTPException(429, { message: "too many feeds added; try later" });
    let title: string;
    try {
      const xml = await withTimeout(fetcherFor(c.get("deps"))(url), FEED_TIMEOUT_MS);
      title = parseFeed(xml, url).title.trim();
    } catch (err) {
      throw new HTTPException(422, { message: `could not load feed: ${errMessage(err)}` });
    }
    const { feed, created } = repo.addFeed(userId, url, title);
    return c.json(feed, created ? 201 : 200);
  });

  r.delete("/feeds/:id", requireAuth, (c) => {
    if (!c.get("repo").deleteFeed(c.get("user").id, c.req.param("id")))
      throw new HTTPException(404, { message: "feed not found" });
    return c.body(null, 204);
  });

  // Concurrent refreshes for the same user share one run (bounds outbound fetches per user).
  const inflight = new Map<string, Promise<number>>();
  r.post("/feeds/refresh", requireAuth, async (c) => {
    const userId = c.get("user").id;
    let run = inflight.get(userId);
    if (!run) {
      if (!refreshCooldown.attempt(userId))
        throw new HTTPException(429, { message: "feeds were refreshed recently; try again in a minute" });
      run = refreshUserFeeds(c.get("repo"), c.get("deps"), userId).finally(() => inflight.delete(userId));
      inflight.set(userId, run);
    }
    const added = await run;
    return c.json({ added, feeds: c.get("repo").listFeeds(userId) });
  });

  return r;
}
