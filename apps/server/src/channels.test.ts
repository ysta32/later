import { describe, it, expect, beforeEach } from "vitest";
import { createServer } from "node:http";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Extracted, User } from "@later/core";
import { createAi } from "@later/core/ai";
import { createApp, type AppConfig, type AppDeps, type Extractor } from "./app.ts";
import { openDb } from "./db.ts";
import type { Mailer, MailMessage } from "./mailer.ts";
import { firstUrl, safeEqual } from "./routes/channels.ts";
import { TaskQueue } from "./routes/io.ts";
import { createFeedFetcher } from "./routes/feeds.ts";

function extracted(url: string, title: string, text: string): Extracted {
  return {
    url,
    title,
    author: null,
    siteName: "Site",
    excerpt: text.slice(0, 40),
    contentHtml: `<p>${text}</p>`,
    textContent: text,
    wordCount: text.split(/\s+/).length,
    leadImage: null,
    publishedAt: null,
  };
}

class FakeExtractor implements Extractor {
  fetchCalls: string[] = [];
  fail = new Set<string>();
  async fetchAndExtract(url: string): Promise<Extracted> {
    this.fetchCalls.push(url);
    await new Promise((r) => setTimeout(r, 1));
    if (this.fail.has(url)) throw new Error("boom: network down");
    return extracted(url, `Fetched ${url}`, "fetched body about gardening and tomatoes");
  }
  extractFromHtml(html: string, url: string): Extracted {
    return extracted(url, "From DOM", html.replace(/<[^>]+>/g, " ").trim());
  }
}

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}

type App = ReturnType<typeof createApp>;
let app: App;
let ex: FakeExtractor;
let mailer: FakeMailer;
let feeds: Map<string, string>;
let deps: AppDeps;

const ORIGIN = "http://localhost:4800";

function make(config: Partial<AppConfig> = {}) {
  ex = new FakeExtractor();
  mailer = new FakeMailer();
  feeds = new Map();
  deps = {
    db: openDb(":memory:"),
    extract: ex,
    config: {
      dataDir: ":memory:",
      signups: true,
      inboundSecret: null,
      publicUrl: ORIGIN,
      smtpUrl: null,
      ...config,
    },
    ai: createAi({ apiKey: "" }),
    mailer,
    fetchFeed: async (url) => {
      const xml = feeds.get(url);
      if (xml === undefined) throw new Error("404");
      return xml;
    },
  };
  app = createApp(deps);
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(path, { method, headers, body });
  const ct = res.headers.get("content-type") ?? "";
  let json: any = null;
  let bytes: Uint8Array | null = null;
  if (ct.includes("json")) json = await res.json();
  else bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, json, bytes, res };
}

async function signup(email: string): Promise<{ user: User; token: string }> {
  const r = await call("POST", "/api/auth/signup", { body: { email, password: "password123" } });
  expect(r.status).toBe(201);
  return r.json;
}

beforeEach(() => make());

describe("health + CORS", () => {
  it("health", async () => {
    const r = await call("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, version: expect.any(String) });
  });

  it("allows cross-origin only for bearer requests, never with credentials", async () => {
    const { token } = await signup("a@x.io");
    const bearer = await call("GET", "/api/articles", { token, headers: { origin: "https://news.site" } });
    expect(bearer.status).toBe(200);
    expect(bearer.res.headers.get("access-control-allow-origin")).toBe("https://news.site");
    expect(bearer.res.headers.get("access-control-allow-credentials")).toBeNull();

    // Bearer failures still carry CORS headers so the extension can read the 401.
    const bad = await call("GET", "/api/articles", {
      token: "nope",
      headers: { origin: "https://news.site" },
    });
    expect(bad.status).toBe(401);
    expect(bad.res.headers.get("access-control-allow-origin")).toBe("https://news.site");

    const cookie = await call("GET", "/api/articles", {
      headers: { origin: "https://evil.site", cookie: `later_session=${token}` },
    });
    expect(cookie.res.headers.get("access-control-allow-origin")).toBeNull();

    const pre = await call("OPTIONS", "/api/articles", {
      headers: {
        origin: "https://news.site",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("https://news.site");
    expect(pre.res.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(pre.res.headers.get("access-control-allow-credentials")).toBeNull();

    const preNoAuth = await call("OPTIONS", "/api/articles", {
      headers: { origin: "https://evil.site", "access-control-request-method": "POST" },
    });
    expect(preNoAuth.res.headers.get("access-control-allow-origin")).toBeNull();

    // Cross-origin cookie state change is still rejected by the CSRF guard.
    const post = await call("POST", "/api/articles", {
      body: { url: "https://a.example/x" },
      headers: { origin: "https://evil.site", cookie: `later_session=${token}` },
    });
    expect(post.status).toBe(403);
  });
});

describe("share + bookmarklet", () => {
  it("redirects to login when signed out", async () => {
    const r = await call("GET", "/share?url=https%3A%2F%2Fa.example%2Fp");
    expect(r.status).toBe(303);
    expect(r.res.headers.get("location")).toBe(
      `/#/login?next=${encodeURIComponent("/share?url=https%3A%2F%2Fa.example%2Fp")}`,
    );
    expect(ex.fetchCalls).toHaveLength(0);
  });

  it("saves the first URL in text and redirects to the article", async () => {
    const { token, user } = await signup("a@x.io");
    const r = await call(
      "GET",
      `/share?text=${encodeURIComponent("look at this: https://a.example/post. wow")}`,
      {
        headers: { cookie: `later_session=${token}`, "sec-fetch-site": "none" },
      },
    );
    expect(r.status).toBe(303);
    const loc = r.res.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/#\/saved\//);
    const id = decodeURIComponent(loc.slice("/#/saved/".length));
    const a = await call("GET", `/api/articles/${id}`, { token });
    expect(a.json.url).toBe("https://a.example/post");
    expect(a.json.source).toBe("share");
    expect(a.json.userId).toBe(user.id);
  });

  it("refuses cross-site initiated shares", async () => {
    const { token } = await signup("a@x.io");
    const r = await call("GET", "/share?url=https%3A%2F%2Fa.example%2Fp", {
      headers: { cookie: `later_session=${token}`, "sec-fetch-site": "cross-site" },
    });
    expect(r.status).toBe(403);
    expect(ex.fetchCalls).toHaveLength(0);
  });

  it("serves the bookmarklet script", async () => {
    const r = await call("GET", "/bookmarklet.js");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toMatch(/^application\/javascript/);
    expect(r.res.headers.get("cache-control")).toBe("no-cache");
    expect(new TextDecoder().decode(r.bytes!)).toMatch(/api\/articles|bookmarklet/);
  });

  it("firstUrl trims punctuation and balances parens", () => {
    expect(firstUrl("see (https://a.example/x_(y)).")).toBe("https://a.example/x_(y)");
    expect(firstUrl("nothing here")).toBeNull();
  });
});

describe("inbound email", () => {
  const SECRET = "s3cret-inbound-value";
  const send = (body: unknown, secret?: string) =>
    call("POST", "/api/inbound/email", {
      body,
      headers: secret === undefined ? {} : { "x-later-inbound-secret": secret },
    });

  it("is 404 when no secret is configured", async () => {
    const r = await send({ to: "save+x@in.later", from: "a@b.c", subject: "s", text: "hi" }, "anything");
    expect(r.status).toBe(404);
  });

  it("enforces the secret and routes by inbound token", async () => {
    make({ inboundSecret: SECRET });
    const a = await signup("a@x.io");
    const b = await signup("b@x.io");
    const msg = (to: string) => ({
      to,
      from: "Me <me@x.io>",
      subject: "fwd",
      text: "https://a.example/story",
    });

    expect((await send(msg(`save+${a.user.inboundToken}@in.later`))).status).toBe(401);
    expect((await send(msg(`save+${a.user.inboundToken}@in.later`), "wrong")).status).toBe(401);
    expect((await send(msg(`save+${a.user.inboundToken}@in.later`), SECRET + "x")).status).toBe(401);
    expect((await send(msg("save+unknown@in.later"), SECRET)).status).toBe(404);

    const ok = await send(msg(`save+${b.user.inboundToken}@in.later`), SECRET);
    expect(ok.status).toBe(201);
    expect(ok.json.userId).toBe(b.user.id);
    expect(ok.json.source).toBe("email");
    expect(ok.json.url).toBe("https://a.example/story");
    expect((await call("GET", "/api/articles", { token: a.token })).json.items).toHaveLength(0);

    ex.fail.add("https://a.example/broken");
    const failed = await send(
      { ...msg(`save+${b.user.inboundToken}@in.later`), text: "https://a.example/broken" },
      SECRET,
    );
    expect(failed.status).toBe(201);
    expect(failed.json.captureStatus).toBe("failed");
  });

  it("saves newsletters as separate articles with empty url", async () => {
    make({ inboundSecret: SECRET });
    const a = await signup("a@x.io");
    const body = "Weekly letter. " + "Lots of interesting words here. ".repeat(30);
    const nl = {
      to: `save+${a.user.inboundToken}@in.later`,
      from: "Letter <news@letter.example>",
      subject: "Issue 1",
      html: `<p>${body}</p><script>alert(1)</script><a href="https://x.example">x</a><a href="https://y.example">y</a>`,
    };
    const r1 = await send(nl, SECRET);
    const r2 = await send({ ...nl, subject: "Issue 2" }, SECRET);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.json.id).not.toBe(r2.json.id);
    expect(r1.json.url).toBe("");
    expect(r1.json.title).toBe("Issue 1");
    expect(r1.json.contentHtml).not.toMatch(/<script/i);
    expect(ex.fetchCalls).toHaveLength(0);
  });

  it("accepts form-encoded provider posts", async () => {
    make({ inboundSecret: SECRET });
    const a = await signup("a@x.io");
    const form = new URLSearchParams({
      recipient: `save+${a.user.inboundToken}@in.later`,
      sender: "me@x.io",
      subject: "link",
      "body-plain": "https://a.example/form",
    });
    const r = await call("POST", "/api/inbound/email", {
      raw: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-later-inbound-secret": SECRET },
    });
    expect(r.status).toBe(201);
    expect(r.json.url).toBe("https://a.example/form");
  });

  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

function rss(items: { guid: string; link: string; title: string; html?: string }[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>My Feed</title>${items
    .map(
      (i) =>
        `<item><guid>${i.guid}</guid><link>${i.link}</link><title>${i.title}</title>${
          i.html ? `<description><![CDATA[${i.html}]]></description>` : ""
        }</item>`,
    )
    .join("")}</channel></rss>`;
}

describe("feeds", () => {
  it("subscribe, refresh dedupes guids, sanitizes inline content, unsubscribe", async () => {
    const { token } = await signup("a@x.io");
    const long = "Inline feed article text that is long enough. ".repeat(20);
    feeds.set(
      "https://f.example/rss",
      rss([
        {
          guid: "g1",
          link: "https://f.example/1",
          title: "One",
          html: `<p>${long}</p><script>evil()</script>`,
        },
        { guid: "g2", link: "https://f.example/2", title: "Two", html: "<p>short teaser</p>" },
      ]),
    );
    expect((await call("POST", "/api/feeds", { token, body: { url: "notaurl" } })).status).toBe(400);
    expect(
      (await call("POST", "/api/feeds", { token, body: { url: "https://f.example/missing" } })).status,
    ).toBe(422);
    const sub = await call("POST", "/api/feeds", { token, body: { url: "https://f.example/rss" } });
    expect(sub.status).toBe(201);
    expect(sub.json.title).toBe("My Feed");
    expect((await call("POST", "/api/feeds", { token, body: { url: "https://f.example/rss" } })).status).toBe(
      200,
    );
    expect((await call("GET", "/api/feeds", { token })).json.items).toHaveLength(1);

    const r1 = await call("POST", "/api/feeds/refresh", { token });
    expect(r1.status).toBe(200);
    expect(r1.json.added).toBe(2);
    expect(ex.fetchCalls).toEqual(["https://f.example/2"]); // short teaser -> full fetch
    const list = (await call("GET", "/api/articles", { token })).json.items;
    expect(list.every((a: any) => a.source === "rss")).toBe(true);
    const one = list.find((a: any) => a.url === "https://f.example/1");
    const full = (await call("GET", `/api/articles/${one.id}`, { token })).json;
    expect(full.contentHtml).toContain("Inline feed article");
    expect(full.contentHtml).not.toMatch(/<script|evil/);

    const r2 = await call("POST", "/api/feeds/refresh", { token });
    expect(r2.json.added).toBe(0);

    feeds.set(
      "https://f.example/rss",
      rss([
        { guid: "g3", link: "https://f.example/3", title: "Three" },
        { guid: "g1", link: "https://f.example/1", title: "One" },
      ]),
    );
    expect((await call("POST", "/api/feeds/refresh", { token })).json.added).toBe(1);

    feeds.delete("https://f.example/rss");
    const r4 = await call("POST", "/api/feeds/refresh", { token });
    expect(r4.json.feeds[0].lastError).toBeTruthy();

    const other = await signup("b@x.io");
    expect((await call("DELETE", `/api/feeds/${sub.json.id}`, { token: other.token })).status).toBe(404);
    expect((await call("DELETE", `/api/feeds/${sub.json.id}`, { token })).status).toBe(204);
  });
});

describe("import", () => {
  const POCKET = `title,url,time_added,tags,status
"Space, time",https://example.com/pocket,1704067200,science|space,unread
Old story,https://example.com/archived,1704153600,history,archive
Bad,file:///tmp/private,invalid,,unread
`;

  it("pocket csv: pending, then ok/failed after the queue drains; re-import skips", async () => {
    const { token } = await signup("a@x.io");
    ex.fail.add("https://example.com/archived");
    const r = await call("POST", "/api/import?format=pocket", {
      token,
      raw: POCKET,
      headers: { "content-type": "text/csv" },
    });
    expect(r.status).toBe(200);
    expect(r.json.imported).toBe(2);
    expect(r.json.skipped).toBe(0);
    let items = (await call("GET", "/api/articles", { token })).json.items;
    expect(items).toHaveLength(2);
    expect(items.every((a: any) => a.captureStatus === "pending" && a.source === "import")).toBe(true);
    const space = items.find((a: any) => a.url === "https://example.com/pocket");
    expect(space.title).toBe("Space, time");
    expect(space.tags).toEqual(["science", "space"]);
    expect(space.savedAt).toBe("2024-01-01T00:00:00.000Z");

    await app.drain();
    items = (await call("GET", "/api/articles", { token })).json.items;
    const byUrl = Object.fromEntries(items.map((a: any) => [a.url, a]));
    expect(byUrl["https://example.com/pocket"].captureStatus).toBe("ok");
    expect(byUrl["https://example.com/archived"].captureStatus).toBe("failed");
    expect(byUrl["https://example.com/archived"].state).toBe("archived");

    const again = await call("POST", "/api/import", {
      token,
      raw: POCKET,
      headers: { "content-type": "text/csv" },
    });
    expect(again.json).toMatchObject({ imported: 0, skipped: 2 });
  });

  it("omnivore zip with highlights; multipart upload", async () => {
    const { token } = await signup("a@x.io");
    const meta1 = JSON.stringify([
      {
        id: "one",
        slug: "space",
        title: "Space",
        url: "https://example.com/omnivore",
        labels: [{ name: "science" }],
        state: "SUCCEEDED",
        savedAt: "2024-01-01T00:00:00Z",
        highlights: [{ quote: "First thought", annotation: "My note" }],
      },
    ]);
    const meta2 = JSON.stringify([
      {
        id: "two",
        slug: "old",
        title: "Old",
        url: "https://example.com/old",
        labels: [],
        state: "ARCHIVED",
        savedAt: "2024-01-02T00:00:00Z",
      },
    ]);
    const zip = zipSync({ "metadata_0_to_1.json": strToU8(meta1), "metadata_1_to_2.json": strToU8(meta2) });
    const fd = new FormData();
    fd.append("file", new Blob([zip as Uint8Array<ArrayBuffer>]), "omnivore.zip");
    const r = await call("POST", "/api/import?format=auto", { token, raw: fd });
    expect(r.status).toBe(200);
    expect(r.json.imported).toBe(2);
    await app.drain();
    const items = (await call("GET", "/api/articles", { token })).json.items;
    const space = items.find((a: any) => a.url === "https://example.com/omnivore");
    expect(space.tags).toEqual(["science"]);
    const hs = (await call("GET", `/api/articles/${space.id}/highlights`, { token })).json.items;
    expect(hs).toHaveLength(1);
    expect(hs[0].note).toBe("My note");
  });

  it("rejects unknown formats and undetectable data", async () => {
    const { token } = await signup("a@x.io");
    expect((await call("POST", "/api/import?format=nope", { token, raw: "x" })).status).toBe(400);
    expect((await call("POST", "/api/import", { token, raw: "just some text" })).status).toBe(400);
  });

  it("TaskQueue respects concurrency and drains", async () => {
    const q = new TaskQueue(3);
    let active = 0;
    let peak = 0;
    let done = 0;
    for (let i = 0; i < 10; i++)
      q.push(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        done++;
        if (i === 4) throw new Error("job error is contained");
      });
    await q.drain();
    expect(done).toBe(10);
    expect(peak).toBe(3);
  });
});

describe("export + kindle", () => {
  async function seeded() {
    const s = await signup("a@x.io");
    const a = await call("POST", "/api/articles", { token: s.token, body: { url: "https://a.example/one" } });
    await call("POST", `/api/articles/${a.json.id}/highlights`, {
      token: s.token,
      body: { quote: "gardening", note: "nice" },
    });
    return { ...s, articleId: a.json.id as string };
  }

  it("json, markdown zip, epub", async () => {
    const { token, articleId } = await seeded();
    const j = await call("GET", "/api/export.json", { token });
    expect(j.status).toBe(200);
    expect(j.res.headers.get("content-disposition")).toMatch(/^attachment; filename="later-export-/);
    expect(j.json.version).toBe(1);
    expect(j.json.articles).toHaveLength(1);
    expect(j.json.highlights).toHaveLength(1);

    const z = await call("GET", "/api/export.md.zip", { token });
    expect(z.res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(z.bytes!);
    const names = Object.keys(files);
    expect(names).toHaveLength(1);
    expect(new TextDecoder().decode(files[names[0]])).toContain("gardening");

    const e = await call("GET", `/api/articles/${articleId}/epub`, { token });
    expect(e.status).toBe(200);
    expect(e.res.headers.get("content-type")).toBe("application/epub+zip");
    expect(e.res.headers.get("content-disposition")).toMatch(/attachment; filename=".+\.epub"/);
    expect(Object.keys(unzipSync(e.bytes!))[0]).toBe("mimetype");

    const multi = await call("GET", `/api/export.epub?ids=${articleId},missing`, { token });
    expect(multi.status).toBe(200);
    expect(multi.res.headers.get("content-type")).toBe("application/epub+zip");
    expect((await call("GET", "/api/export.epub", { token })).status).toBe(200);
    expect((await call("GET", "/api/export.epub?ids=missing", { token })).status).toBe(404);

    const other = await signup("b@x.io");
    expect((await call("GET", `/api/articles/${articleId}/epub`, { token: other.token })).status).toBe(404);
  });

  it("kindle: 400 without kindle email, 501 without SMTP, 202 with fake mailer", async () => {
    const { token, articleId } = await seeded();
    expect((await call("POST", `/api/articles/${articleId}/kindle`, { token })).status).toBe(400);
    await call("PATCH", "/api/me", { token, body: { kindleEmail: "me@kindle.com" } });
    expect((await call("POST", `/api/articles/${articleId}/kindle`, { token })).status).toBe(501);
    expect(mailer.sent).toHaveLength(0);

    make({ smtpUrl: "smtp://fake.invalid:25", mailFrom: "Later <later@example.com>" });
    const s = await signup("k@x.io");
    const a = await call("POST", "/api/articles", { token: s.token, body: { url: "https://a.example/k" } });
    await call("PATCH", "/api/me", { token: s.token, body: { kindleEmail: "me@kindle.com" } });
    const r = await call("POST", `/api/articles/${a.json.id}/kindle`, { token: s.token });
    expect(r.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("me@kindle.com");
    expect(mailer.sent[0].from).toBe("Later <later@example.com>");
    expect(mailer.sent[0].attachments?.[0].contentType).toBe("application/epub+zip");
    expect(mailer.sent[0].attachments?.[0].filename).toMatch(/\.epub$/);
  });
});

describe("ai", () => {
  it("status, extractive summary stored, ask falls back to recent articles", async () => {
    const { token } = await signup("a@x.io");
    const st = await call("GET", "/api/ai/status", { token });
    expect(st.json.enabled).toBe(false);
    const a = await call("POST", "/api/articles", { token, body: { url: "https://a.example/garden" } });
    const s = await call("POST", `/api/articles/${a.json.id}/summary`, { token });
    expect(s.status).toBe(200);
    expect(s.json.method).toBe("extractive");
    expect((await call("GET", `/api/articles/${a.json.id}`, { token })).json.summary).toBe(s.json.summary);

    const hit = await call("POST", "/api/ask", { token, body: { question: "tomatoes" } });
    expect(hit.status).toBe(200);
    expect(hit.json.method).toBe("search");
    expect(hit.json.sources.map((x: any) => x.id)).toEqual([a.json.id]);
    expect(hit.json.sources[0]).not.toHaveProperty("text");

    // No FTS hit: falls back to recent articles as the document set.
    const miss = await call("POST", "/api/ask", {
      token,
      body: { question: "what about zzzqqq gardening?" },
    });
    expect(miss.status).toBe(200);
    expect(miss.json.method).toBe("search");

    expect((await call("POST", "/api/ask", { token, body: { question: "" } })).status).toBe(400);
  });
});

describe("obsidian sync", () => {
  it("filters by since and bumps on highlight change", async () => {
    const { token } = await signup("a@x.io");
    const a = await call("POST", "/api/articles", { token, body: { url: "https://a.example/1" } });
    await call("POST", "/api/articles", { token, body: { url: "https://a.example/2" } });
    const all = await call("GET", "/api/obsidian/sync", { token });
    expect(all.json.articles).toHaveLength(2);
    expect(all.json.articles[0].path).toMatch(/^Later\/.+\.md$/);
    const cursor = all.json.cursor as string;
    expect(typeof cursor).toBe("string");

    const none = await call("GET", `/api/obsidian/sync?since=${encodeURIComponent(cursor)}`, { token });
    expect(none.json.articles).toHaveLength(0);
    expect(none.json.cursor).toBe(cursor);

    await new Promise((r) => setTimeout(r, 5));
    await call("POST", `/api/articles/${a.json.id}/highlights`, { token, body: { quote: "gardening" } });
    const one = await call("GET", `/api/obsidian/sync?since=${encodeURIComponent(cursor)}`, { token });
    expect(one.json.articles).toHaveLength(1);
    expect(one.json.articles[0].markdown).toContain("gardening");
    expect(one.json.cursor > cursor).toBe(true);

    expect((await call("GET", "/api/obsidian/sync?since=garbage", { token })).status).toBe(400);
  });
});

describe("feed fetcher (real transport)", () => {
  it("blocks private addresses (also via redirect) unless allowPrivate", async () => {
    const srv = createServer((req, res) => {
      if (req.url === "/r") {
        res.writeHead(302, { location: "/feed" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end("<rss><channel><title>T</title></channel></rss>");
    });
    await new Promise<void>((r) => srv.listen(4856, "127.0.0.1", () => r()));
    try {
      await expect(createFeedFetcher()("http://127.0.0.1:4856/r")).rejects.toThrow(/non-public/);
      await expect(createFeedFetcher()("http://localhost:4856/feed")).rejects.toThrow(/non-public/);
      expect(await createFeedFetcher({ allowPrivate: true })("http://127.0.0.1:4856/r")).toContain(
        "<title>T</title>",
      );
    } finally {
      srv.close();
    }
  });
});
