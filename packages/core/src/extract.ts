import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Extracted } from "./types.ts";
import { countWords, htmlToText, sanitizeHtml } from "./sanitize.ts";

export type ExtractErrorCode = "fetch" | "http" | "not_html" | "empty";

export class ExtractError extends Error {
  code: ExtractErrorCode;
  status: number | null;
  constructor(code: ExtractErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ExtractError";
    this.code = code;
    this.status = opts.status ?? null;
  }
}

export interface FetchExtractOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** DNS resolver used by the SSRF guard (injectable for tests). */
  lookup?: LookupFn;
  /** Skip the private-address check (self-hosters; server sets it from LATER_ALLOW_PRIVATE_FETCH=1). */
  allowPrivate?: boolean;
}

/** Text shorter than this is considered a failed/insufficient extraction. */
const MIN_CHARS = 200;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

type Method = "readability" | "jsonld" | "container" | "body" | "description";

interface InternalResult {
  extracted: Extracted;
  method: Method;
  ampUrl: string | null;
}

function parseDoc(html: string): Document {
  return (parseHTML(html) as unknown as { document: Document }).document;
}

function clean(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function httpUrl(value: string | null | undefined, base: string): string | null {
  const v = clean(value);
  if (!v) return null;
  try {
    const u = new URL(v, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function toIso(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function meta(doc: Document, ...keys: string[]): string | null {
  for (const key of keys) {
    for (const el of Array.from(doc.querySelectorAll("meta"))) {
      const k = (
        el.getAttribute("property") ??
        el.getAttribute("name") ??
        el.getAttribute("itemprop") ??
        ""
      ).toLowerCase();
      if (k === key) {
        const c = clean(el.getAttribute("content"));
        if (c) return c;
      }
    }
  }
  return null;
}

function linkHref(doc: Document, rel: string): string | null {
  for (const el of Array.from(doc.querySelectorAll("link[rel][href]"))) {
    const rels = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (rels.includes(rel)) return el.getAttribute("href");
  }
  return null;
}

// ---------- JSON-LD ----------

type Json = Record<string, unknown>;

interface LdArticle {
  headline: string | null;
  body: string | null;
  author: string | null;
  datePublished: string | null;
  image: string | null;
  publisher: string | null;
  description: string | null;
}

const ARTICLE_TYPES = /(Article|BlogPosting|Report|Posting|NewsArticle|WebPage)$/;

function flattenLd(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out);
  } else if (node && typeof node === "object") {
    const o = node as Json;
    out.push(o);
    if (o["@graph"]) flattenLd(o["@graph"], out);
    if (o.mainEntity) flattenLd(o.mainEntity, out);
  }
}

function ldTypes(o: Json): string[] {
  const t = o["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

function ldName(v: unknown): string | null {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) {
    const names = v.map(ldName).filter((x): x is string => !!x);
    return names.length ? names.join(", ") : null;
  }
  if (v && typeof v === "object") return clean((v as Json).name as string);
  return null;
}

function ldImage(v: unknown): string | null {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = ldImage(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === "object")
    return clean((v as Json).url as string) ?? clean((v as Json).contentUrl as string);
  return null;
}

function readJsonLd(doc: Document): LdArticle | null {
  const nodes: Json[] = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = (s.textContent ?? "").replace(/^\s*<!--|-->\s*$/g, "").trim();
    if (!raw) continue;
    try {
      flattenLd(JSON.parse(raw), nodes);
    } catch {
      // Malformed JSON-LD is common in the wild; it is optional metadata, so skip that block.
      continue;
    }
  }
  const articles = nodes.filter((n) => ldTypes(n).some((t) => ARTICLE_TYPES.test(t)));
  if (!articles.length) return null;
  // Prefer a real Article type with a body over a generic WebPage.
  articles.sort((a, b) => score(b) - score(a));
  const best = articles[0];
  const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() || null : null);
  return {
    headline: clean(str(best.headline) ?? str(best.name)),
    body: str(best.articleBody) ?? str(best.text),
    author: ldName(best.author) ?? ldName(best.creator),
    datePublished: str(best.datePublished) ?? str(best.dateCreated),
    image: ldImage(best.image) ?? ldImage(best.thumbnailUrl),
    publisher: ldName(best.publisher),
    description: clean(str(best.description)),
  };

  function score(n: Json): number {
    let s = 0;
    if (typeof n.articleBody === "string" || typeof n.text === "string") s += 4;
    if (ldTypes(n).some((t) => t !== "WebPage" && ARTICLE_TYPES.test(t))) s += 2;
    if (n.headline) s += 1;
    return s;
  }
}

function textToHtml(text: string): string {
  return text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function looksLikeHtml(s: string): boolean {
  return /<(p|div|br|h[1-6]|ul|ol|li|blockquote)[\s>/]/i.test(s);
}

function bodyLength(html: string): number {
  return htmlToText(html).length;
}

const JUNK_SELECTOR =
  "script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, [role=navigation], [aria-hidden=true]";

function extractInternal(html: string, url: string): InternalResult {
  const doc = parseDoc(html);

  let fallbackHost = "";
  try {
    fallbackHost = new URL(url).hostname;
  } catch {
    fallbackHost = "";
  }

  const baseHref = (() => {
    const b = doc.querySelector("base[href]")?.getAttribute("href");
    return (b && httpUrl(b, url)) || url;
  })();
  const canonical = httpUrl(linkHref(doc, "canonical"), baseHref) ?? httpUrl(meta(doc, "og:url"), baseHref);
  const finalUrl = canonical ?? url;
  const ampUrl = httpUrl(linkHref(doc, "amphtml"), baseHref);

  const ld = readJsonLd(doc);
  const description =
    meta(doc, "og:description", "description", "twitter:description") ?? ld?.description ?? null;
  const ogTitle = meta(doc, "og:title", "twitter:title");
  const docTitle = clean(doc.querySelector("title")?.textContent);
  const h1 = clean(doc.querySelector("h1")?.textContent);
  const metaAuthor = meta(doc, "author", "article:author", "parsely-author", "sailthru.author", "dc.creator");
  const author = (metaAuthor && !/^https?:\/\//i.test(metaAuthor) ? metaAuthor : null) ?? ld?.author ?? null;
  const siteName = meta(doc, "og:site_name", "application-name") ?? ld?.publisher ?? null;
  const publishedAt =
    toIso(
      meta(
        doc,
        "article:published_time",
        "og:published_time",
        "datepublished",
        "date",
        "dc.date",
        "parsely-pub-date",
      ),
    ) ??
    toIso(ld?.datePublished) ??
    toIso(doc.querySelector("time[datetime]")?.getAttribute("datetime"));
  const leadImage =
    httpUrl(
      meta(doc, "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"),
      baseHref,
    ) ?? httpUrl(ld?.image, baseHref);

  // 1. Readability on a separate parse (Readability mutates the document).
  let readable: ReturnType<Readability["parse"]> = null;
  try {
    readable = new Readability(parseDoc(html), { charThreshold: 300 }).parse();
  } catch {
    // Readability can throw on pathological markup; the ladder below covers that case.
    readable = null;
  }

  const candidates: { method: Method; html: string; len: number }[] = [];
  const add = (method: Method, h: string | null | undefined): void => {
    if (!h) return;
    const len = bodyLength(h);
    if (len > 0) candidates.push({ method, html: h, len });
  };

  add("readability", readable?.content ?? null);
  // 2. JSON-LD articleBody (news sites that render the body client-side).
  if (ld?.body) add("jsonld", looksLikeHtml(ld.body) ? ld.body : textToHtml(ld.body));
  // 3. Largest <article>/<main> container.
  {
    let best: Element | null = null;
    let bestLen = 0;
    for (const el of Array.from(doc.querySelectorAll("article, main, [role=main]"))) {
      const len = (el.textContent ?? "").trim().length;
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
    if (best) {
      for (const j of Array.from(best.querySelectorAll(JUNK_SELECTOR))) j.remove();
      add("container", best.innerHTML);
    }
  }
  // 4. Whole body text minus obvious chrome.
  if (doc.body) {
    for (const j of Array.from(doc.body.querySelectorAll(JUNK_SELECTOR))) j.remove();
    add("body", doc.body.innerHTML);
  }
  // 5. Description alone.
  if (description) add("description", `<p>${escapeHtml(description)}</p>`);

  // First rung that yields enough text wins; otherwise the longest real-content rung, and the
  // description only when the page has no body text at all.
  const chosen =
    candidates.find((c) => c.len >= MIN_CHARS) ??
    candidates.filter((c) => c.method !== "description").sort((a, b) => b.len - a.len)[0] ??
    candidates[0];
  if (!chosen) throw new ExtractError("empty", `No readable content found at ${url}`);

  let contentHtml = sanitizeHtml(chosen.html, baseHref);
  // For short fallbacks, lead with the description so the reader gets some context.
  if (chosen.method !== "description" && chosen.len < MIN_CHARS && description) {
    const descTxt = description.toLowerCase();
    if (!htmlToText(contentHtml).toLowerCase().includes(descTxt)) {
      contentHtml = `<p>${escapeHtml(description)}</p>\n${contentHtml}`;
    }
  }
  const textContent = htmlToText(contentHtml);
  if (!textContent) throw new ExtractError("empty", `No readable content found at ${url}`);

  const title =
    clean(readable?.title) ?? ogTitle ?? ld?.headline ?? docTitle ?? h1 ?? (fallbackHost || finalUrl);
  const excerpt = description ?? clean(readable?.excerpt) ?? clean(textContent.slice(0, 280));

  return {
    method: chosen.method,
    ampUrl,
    extracted: {
      url: finalUrl,
      title,
      author: author ?? clean(readable?.byline),
      siteName: siteName ?? clean(readable?.siteName),
      excerpt,
      contentHtml,
      textContent,
      wordCount: countWords(textContent),
      leadImage,
      publishedAt: publishedAt ?? toIso(readable?.publishedTime),
    },
  };
}

/** Extract readable content + metadata from an HTML string. Throws ExtractError("empty") if nothing usable. */
export function extractFromHtml(html: string, url: string): Extracted {
  return extractInternal(html, url).extracted;
}

// ---------- decoding ----------

function sniffCharset(bytes: Uint8Array, contentType: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i) ??
    head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i);
  return m?.[1] ?? "utf-8";
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const label = sniffCharset(bytes, contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function isHtmlType(ct: string): boolean {
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(ct.trim());
}

function looksLikeHtmlBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") || head.startsWith("<html") || /<(head|body|title)[\s>]/.test(head)
  );
}

// ---------- SSRF guard ----------

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface UrlPolicyOptions {
  lookup?: LookupFn;
  allowPrivate?: boolean;
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base) as number;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable: fail closed
  return (
    inV4(n, "0.0.0.0", 8) ||
    inV4(n, "10.0.0.0", 8) ||
    inV4(n, "100.64.0.0", 10) ||
    inV4(n, "127.0.0.0", 8) ||
    inV4(n, "169.254.0.0", 16) ||
    inV4(n, "172.16.0.0", 12) ||
    inV4(n, "192.0.0.0", 24) ||
    inV4(n, "192.168.0.0", 16) ||
    inV4(n, "198.18.0.0", 15) ||
    inV4(n, "224.0.0.0", 4) || // multicast
    inV4(n, "240.0.0.0", 4) // reserved + broadcast
  );
}

/** Expand an IPv6 address to 8 16-bit groups (handles "::" and a trailing dotted IPv4). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string): number[] => (h ? h.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // fail closed
  const embeddedV4 = (): string => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(embeddedV4()); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4()); // deprecated ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return isPrivateV4(embeddedV4()); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2002) return isPrivateV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  return false;
}

/** True if an IP literal is loopback/private/link-local/CGNAT/multicast/reserved (or unparseable). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

/**
 * Validate that a URL is safe to fetch server-side: http(s) only, no credentials, and (unless
 * allowPrivate) every resolved address is public. Throws ExtractError("fetch") otherwise.
 */
export async function assertPublicUrl(url: string | URL, opts: UrlPolicyOptions = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch (err) {
    throw new ExtractError("fetch", `Invalid URL: ${String(url)}`, { cause: err });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ExtractError("fetch", `Unsupported URL scheme: ${u.protocol}`);
  }
  if (u.username || u.password) throw new ExtractError("fetch", "URLs with credentials are not allowed");
  if (opts.allowPrivate) return u;
  const host = u.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host) throw new ExtractError("fetch", `Invalid URL host: ${u.href}`);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ExtractError("fetch", `Blocked non-public address: ${host}`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new ExtractError("fetch", `Blocked non-public address: ${host}`);
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await (opts.lookup ?? defaultLookup)(host);
  } catch (err) {
    throw new ExtractError("fetch", `DNS lookup failed for ${host}`, { cause: err });
  }
  if (!addrs.length) throw new ExtractError("fetch", `DNS lookup returned no addresses for ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address))
      throw new ExtractError("fetch", `Blocked non-public address for ${host}: ${a.address}`);
  }
  return u;
}

// ---------- fetching ----------

interface Fetched {
  html: string;
  url: string;
}

interface FetchCtx {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  policy: UrlPolicyOptions;
}

const MAX_REDIRECTS = 5;

class RetryableError extends Error {
  inner: ExtractError;
  constructor(inner: ExtractError) {
    super(inner.message);
    this.inner = inner;
  }
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Releasing the connection is best-effort; the response is already being discarded.
  }
}

async function fetchOnce(startUrl: string, ua: string, ctx: FetchCtx): Promise<Fetched> {
  const { fetchImpl, timeoutMs } = ctx;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExtractError("fetch", `Timed out after ${timeoutMs}ms fetching ${startUrl}`));
    }, timeoutMs);
  });
  const timedOut = (err: unknown): ExtractError =>
    new ExtractError("fetch", `Timed out after ${timeoutMs}ms fetching ${startUrl}`, { cause: err });
  const run = async (): Promise<Fetched> => {
    let url = startUrl;
    let res: Response | null = null;
    for (let hop = 0; ; hop++) {
      const checked = await assertPublicUrl(url, ctx.policy);
      url = checked.href;
      try {
        res = await fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": ua,
            Accept: ACCEPT,
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
      } catch (err) {
        if (controller.signal.aborted) throw timedOut(err);
        throw new RetryableError(
          new ExtractError(
            "fetch",
            `Network error fetching ${url}: ${(err as Error)?.message ?? String(err)}`,
            { cause: err },
          ),
        );
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get("location");
        await cancelBody(res);
        if (!loc)
          throw new ExtractError("http", `Redirect without Location from ${url}`, { status: res.status });
        if (hop >= MAX_REDIRECTS)
          throw new ExtractError("fetch", `Too many redirects starting at ${startUrl}`);
        try {
          url = new URL(loc, url).href;
        } catch (err) {
          throw new ExtractError("fetch", `Invalid redirect target "${loc}" from ${url}`, { cause: err });
        }
        continue;
      }
      if (res.type === "opaqueredirect") {
        throw new ExtractError("fetch", `Unfollowable redirect from ${url}`);
      }
      break;
    }
    if (!res.ok) {
      await cancelBody(res);
      const e = new ExtractError("http", `HTTP ${res.status} fetching ${url}`, { status: res.status });
      if (res.status >= 500 || res.status === 403 || res.status === 429) throw new RetryableError(e);
      throw e;
    }
    const ct = res.headers.get("content-type");
    if (ct && !isHtmlType(ct)) {
      await cancelBody(res);
      throw new ExtractError("not_html", `Unsupported content type "${ct}" at ${url}`, {
        status: res.status,
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (controller.signal.aborted) throw timedOut(err);
      throw new RetryableError(new ExtractError("fetch", `Error reading body of ${url}`, { cause: err }));
    }
    if (!ct) {
      const head = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
      if (head === "%PDF-" || !looksLikeHtmlBytes(bytes)) {
        throw new ExtractError("not_html", `Response at ${url} is not HTML`, { status: res.status });
      }
    }
    return { html: decode(bytes, ct), url };
  };
  try {
    const pending = run();
    // If the timeout wins the race, the late rejection of run() must not become unhandled.
    pending.catch(() => undefined);
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string, ctx: FetchCtx): Promise<Fetched> {
  try {
    return await fetchOnce(url, BROWSER_UA, ctx);
  } catch (err) {
    if (!(err instanceof RetryableError)) throw err;
    try {
      return await fetchOnce(url, GOOGLEBOT_UA, ctx);
    } catch (err2) {
      throw err2 instanceof RetryableError ? err2.inner : err2;
    }
  }
}

/** Fetch a URL server-side and extract readable content. Throws ExtractError on failure. */
export async function fetchAndExtract(url: string, opts: FetchExtractOptions = {}): Promise<Extracted> {
  const ctx: FetchCtx = {
    fetchImpl: opts.fetch ?? globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? 15000,
    policy: { lookup: opts.lookup, allowPrivate: opts.allowPrivate ?? false },
  };
  const parsed = await assertPublicUrl(url, ctx.policy);

  const page = await fetchHtml(parsed.href, ctx);
  const main = extractInternal(page.html, page.url);
  const weak = main.method !== "readability" && main.method !== "jsonld";
  const short = main.extracted.textContent.length < MIN_CHARS;
  if (main.ampUrl && main.ampUrl !== page.url && (weak || short)) {
    let amp: InternalResult | null = null;
    try {
      // fetchHtml re-validates the AMP URL (and each of its redirect hops) against the SSRF policy.
      const ampPage = await fetchHtml(main.ampUrl, ctx);
      amp = extractInternal(ampPage.html, ampPage.url);
    } catch (err) {
      // AMP is a best-effort fallback: on any extraction failure keep the primary result (already valid).
      if (!(err instanceof ExtractError)) throw err;
      amp = null;
    }
    const ampGood =
      amp &&
      (amp.method === "readability" ||
        amp.method === "jsonld" ||
        amp.extracted.textContent.length > main.extracted.textContent.length);
    if (amp && ampGood && amp.extracted.textContent.length >= main.extracted.textContent.length * 0.5) {
      const m = main.extracted;
      const a = amp.extracted;
      return {
        ...a,
        url: m.url, // canonical of the primary page (AMP pages point back to it anyway)
        title: m.title || a.title,
        author: m.author ?? a.author,
        siteName: m.siteName ?? a.siteName,
        excerpt: m.excerpt ?? a.excerpt,
        leadImage: m.leadImage ?? a.leadImage,
        publishedAt: m.publishedAt ?? a.publishedAt,
      };
    }
  }
  return main.extracted;
}
