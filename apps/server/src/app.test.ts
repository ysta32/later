import { describe, it, expect, beforeEach } from "vitest";
import type { Article, Extracted, Highlight, User } from "@later/core";
import { createApp, type AppConfig, type Extractor } from "./app.ts";
import { openDb } from "./db.ts";
import { hashPassword, verifyPassword, RateLimiter } from "./auth.ts";
import { ftsQuery } from "./repo.ts";
import { normalizeUrl } from "./routes/articles.ts";

type App = ReturnType<typeof createApp>;

function extracted(url: string, title: string, text: string): Extracted {
  return {
    url,
    title,
    author: "Ann",
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
  htmlCalls: string[] = [];
  failFetch = false;
  failHtml = false;
  async fetchAndExtract(url: string): Promise<Extracted> {
    this.fetchCalls.push(url);
    if (this.failFetch) throw new Error("boom: network down");
    return extracted(url, `Fetched ${url}`, "fetched body about gardening and tomatoes");
  }
  extractFromHtml(html: string, url: string): Extracted {
    this.htmlCalls.push(url);
    if (this.failHtml) throw new Error("bad html");
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
    return extracted(url, "From DOM", text);
  }
}

let app: App;
let ex: FakeExtractor;

function make(config: Partial<AppConfig> = {}) {
  ex = new FakeExtractor();
  app = createApp({
    db: openDb(":memory:"),
    extract: ex,
    config: {
      dataDir: ":memory:",
      signups: true,
      inboundSecret: null,
      publicUrl: "http://localhost:4800",
      smtpUrl: null,
      ...config,
    },
  });
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

async function signup(email: string, password = "password123"): Promise<{ user: User; token: string }> {
  const r = await call("POST", "/api/auth/signup", { body: { email, password } });
  expect(r.status).toBe(201);
  return r.json;
}

async function save(token: string, body: Record<string, unknown>) {
  return call("POST", "/api/articles", { token, body });
}

beforeEach(() => make());

describe("auth", () => {
  it("signup, me, login, logout", async () => {
    const s = await signup("A@Example.com");
    expect(s.user.email).toBe("a@example.com");
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.user).not.toHaveProperty("passwordHash");
    expect((await call("GET", "/api/me", { token: s.token })).json.user.id).toBe(s.user.id);

    const login = await call("POST", "/api/auth/login", {
      body: { email: "a@example.COM", password: "password123" },
    });
    expect(login.status).toBe(200);
    const cookie = login.res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/later_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);

    const cookieVal = /later_session=([^;]+)/.exec(cookie)![1];
    const me = await call("GET", "/api/me", { headers: { cookie: `later_session=${cookieVal}` } });
    expect(me.status).toBe(200);

    expect(
      (
        await call("POST", "/api/auth/logout", {
          headers: { cookie: `later_session=${cookieVal}`, origin: "http://localhost:4800" },
        })
      ).status,
    ).toBe(204);
    expect((await call("GET", "/api/me", { headers: { cookie: `later_session=${cookieVal}` } })).status).toBe(
      401,
    );
    // other session still valid
    expect((await call("GET", "/api/me", { token: s.token })).status).toBe(200);
  });

  it("secure cookie when publicUrl is https", async () => {
    make({ publicUrl: "https://later.example.com" });
    const r = await call("POST", "/api/auth/signup", { body: { email: "a@x.io", password: "password123" } });
    expect(r.res.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("rejects bad credentials and inputs", async () => {
    await signup("a@x.io");
    expect(
      (await call("POST", "/api/auth/login", { body: { email: "a@x.io", password: "wrongpassword" } }))
        .status,
    ).toBe(401);
    const unknown = await call("POST", "/api/auth/login", {
      body: { email: "nobody@x.io", password: "wrongpassword" },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error).toBe("invalid email or password");
    expect(
      (await call("POST", "/api/auth/signup", { body: { email: "b@x.io", password: "short" } })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/auth/signup", { body: { email: "not-an-email", password: "password123" } }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/auth/signup", { body: { email: "A@X.io", password: "password123" } })).status,
    ).toBe(409);
    expect((await call("POST", "/api/auth/signup", { body: "{not json" })).status).toBe(400);
    expect((await call("POST", "/api/auth/signup", { body: [1, 2] })).status).toBe(400);
  });

  it("requires auth and rejects garbage/forged tokens", async () => {
    for (const [m, p] of [
      ["GET", "/api/me"],
      ["GET", "/api/articles"],
      ["POST", "/api/articles"],
      ["GET", "/api/highlights"],
      ["GET", "/api/search?q=x"],
      ["GET", "/api/tags"],
      ["POST", "/api/tokens"],
    ]) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
    }
    expect((await call("GET", "/api/me", { token: "nope" })).status).toBe(401);
    expect((await call("GET", "/api/me", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await call("GET", "/api/me", { headers: { cookie: "later_session=forged" } })).status).toBe(401);
  });

  it("signups off still allows the first user, then blocks", async () => {
    make({ signups: false });
    await signup("first@x.io");
    const r = await call("POST", "/api/auth/signup", {
      body: { email: "second@x.io", password: "password123" },
    });
    expect(r.status).toBe(403);
    // existing user can still log in
    expect(
      (await call("POST", "/api/auth/login", { body: { email: "first@x.io", password: "password123" } }))
        .status,
    ).toBe(200);
  });

  it("signups off: concurrent first signups produce exactly one user", async () => {
    make({ signups: false });
    const rs = await Promise.all(
      ["a@x.io", "b@x.io", "c@x.io"].map((email) =>
        call("POST", "/api/auth/signup", { body: { email, password: "password123" } }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 403)).toHaveLength(2);
  });

  it("rate limits repeated failed logins per ip+email", async () => {
    await signup("a@x.io");
    for (let i = 0; i < 10; i++) {
      expect(
        (await call("POST", "/api/auth/login", { body: { email: "a@x.io", password: "wrongpass" + i } }))
          .status,
      ).toBe(401);
    }
    // even the right password is refused while limited
    expect(
      (await call("POST", "/api/auth/login", { body: { email: "a@x.io", password: "password123" } })).status,
    ).toBe(429);
  }, 20_000);

  it("API tokens authenticate, survive logout, and need a label", async () => {
    const s = await signup("a@x.io");
    expect((await call("POST", "/api/tokens", { token: s.token, body: {} })).status).toBe(400);
    const t = await call("POST", "/api/tokens", { token: s.token, body: { label: "extension" } });
    expect(t.status).toBe(201);
    expect(t.json.token).not.toBe(s.token);
    expect((await call("GET", "/api/me", { token: t.json.token })).json.user.id).toBe(s.user.id);
    expect((await call("POST", "/api/auth/logout", { token: t.json.token })).status).toBe(204);
    expect((await call("GET", "/api/me", { token: t.json.token })).status).toBe(200);
    expect((await call("POST", "/api/auth/logout", { token: s.token })).status).toBe(204);
    expect((await call("GET", "/api/me", { token: s.token })).status).toBe(401);
  });

  it("PATCH /me validates kindleEmail", async () => {
    const s = await signup("a@x.io");
    expect(
      (await call("PATCH", "/api/me", { token: s.token, body: { kindleEmail: "me@kindle.com" } })).json.user
        .kindleEmail,
    ).toBe("me@kindle.com");
    expect((await call("PATCH", "/api/me", { token: s.token, body: { kindleEmail: "nope" } })).status).toBe(
      400,
    );
    expect(
      (await call("PATCH", "/api/me", { token: s.token, body: { kindleEmail: null } })).json.user.kindleEmail,
    ).toBeNull();
  });

  it("cookie auth rejects cross-origin writes but allows same-origin and bearer", async () => {
    const s = await signup("a@x.io");
    const cookie = `later_session=${s.token}`;
    const evil = await call("POST", "/api/articles", {
      headers: { cookie, origin: "https://evil.example" },
      body: { url: "https://a.com/x" },
    });
    expect(evil.status).toBe(403);
    // neither Origin nor Sec-Fetch-Site on a cookie-authenticated write -> rejected
    expect(
      (await call("POST", "/api/articles", { headers: { cookie }, body: { url: "https://a.com/x" } })).status,
    ).toBe(403);
    expect((await call("DELETE", "/api/articles/whatever", { headers: { cookie } })).status).toBe(403);
    expect(
      (
        await call("POST", "/api/articles", {
          headers: { cookie, "sec-fetch-site": "cross-site" },
          body: { url: "https://a.com/x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/api/articles", {
          headers: { cookie, "sec-fetch-site": "same-site" },
          body: { url: "https://a.com/x" },
        })
      ).status,
    ).toBe(403);
    // cookie GETs need no origin signal
    expect((await call("GET", "/api/me", { headers: { cookie } })).status).toBe(200);
    // logout via cookie is guarded too (session survives a forged logout)
    expect((await call("POST", "/api/auth/logout", { headers: { cookie } })).status).toBe(403);
    expect(
      (await call("POST", "/api/auth/logout", { headers: { cookie, origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect((await call("GET", "/api/me", { headers: { cookie } })).status).toBe(200);
    const sfs = await call("POST", "/api/articles", {
      headers: { cookie, "sec-fetch-site": "same-origin" },
      body: { url: "https://a.com/z" },
    });
    expect(sfs.status).toBe(201);
    const ok = await call("POST", "/api/articles", {
      headers: { cookie, origin: "http://localhost:4800" },
      body: { url: "https://a.com/x" },
    });
    expect(ok.status).toBe(201);
    const bearer = await call("POST", "/api/articles", {
      token: s.token,
      headers: { origin: "https://evil.example" },
      body: { url: "https://a.com/y" },
    });
    expect(bearer.status).toBe(201);
  });

  it("blocks login/signup CSRF: foreign origin and non-JSON content types", async () => {
    await signup("a@x.io");
    const creds = JSON.stringify({ email: "a@x.io", password: "password123" });
    for (const path of ["/api/auth/login", "/api/auth/signup"]) {
      const evil = await call("POST", path, {
        headers: { origin: "https://evil.example" },
        body: { email: "z@x.io", password: "password123" },
      });
      expect(evil.status, path).toBe(403);
      const cross = await call("POST", path, {
        headers: { "sec-fetch-site": "cross-site" },
        body: { email: "z@x.io", password: "password123" },
      });
      expect(cross.status, path).toBe(403);
    }
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": ct },
        body: creds,
      });
      expect(r.status, ct).toBe(415);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const noCt = await app.request("/api/auth/login", { method: "POST", body: creds });
    expect(noCt.status).toBe(415);
    // same-origin browser login and header-less (non-browser) clients still work
    const same = await call("POST", "/api/auth/login", {
      headers: { origin: "http://localhost:4800", "sec-fetch-site": "same-origin" },
      body: { email: "a@x.io", password: "password123" },
    });
    expect(same.status).toBe(200);
    const withCharset = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: creds,
    });
    expect(withCharset.status).toBe(200);
    // JSON content type is required on authed JSON routes too
    const tok = same.json.token;
    const patch = await app.request("/api/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${tok}`, "content-type": "text/plain" },
      body: JSON.stringify({ kindleEmail: null }),
    });
    expect(patch.status).toBe(415);
  });

  it("concurrent wrong-password logins cannot exceed the limit", async () => {
    await signup("a@x.io");
    const rs = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        call("POST", "/api/auth/login", { body: { email: "a@x.io", password: `wrongpass${i}` } }),
      ),
    );
    expect(rs.filter((r) => r.status === 401)).toHaveLength(10);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(14);
  }, 20_000);

  it("successful logins are refunded", async () => {
    await signup("a@x.io");
    for (let i = 0; i < 15; i++) {
      expect(
        (await call("POST", "/api/auth/login", { body: { email: "a@x.io", password: "password123" } }))
          .status,
      ).toBe(200);
    }
  }, 20_000);

  it("rate limits signups and token creation per IP", async () => {
    const first = await signup("u0@x.io");
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call("POST", "/api/auth/signup", { body: { email: `u${i + 1}@x.io`, password: "password123" } }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(9);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(3);

    const ts = await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        call("POST", "/api/tokens", { token: first.token, body: { label: `t${i}` } }),
      ),
    );
    expect(ts.filter((r) => r.status === 201)).toHaveLength(20);
    expect(ts.filter((r) => r.status === 429)).toHaveLength(2);
  }, 20_000);

  it("body size limits: 1 MB default, 20 MB for POST /api/articles", async () => {
    const s = await signup("a@x.io");
    const big = "x".repeat(2 * 1024 * 1024);
    const r1 = await call("PATCH", "/api/me", { token: s.token, body: { kindleEmail: null, pad: big } });
    expect(r1.status).toBe(413);
    const r2 = await call("POST", "/api/auth/login", {
      body: { email: "a@x.io", password: "password123", pad: big },
    });
    expect(r2.status).toBe(413);
    const r3 = await call("POST", "/api/articles", {
      token: s.token,
      body: { url: "https://e.com/big", html: `<p>${big}</p>` },
    });
    expect(r3.status).toBe(201);
    const huge = "x".repeat(21 * 1024 * 1024);
    const r4 = await call("POST", "/api/articles", {
      token: s.token,
      body: { url: "https://e.com/huge", html: huge },
    });
    expect(r4.status).toBe(413);
  }, 20_000);
});

describe("password hashing", () => {
  it("round-trips and rejects malformed hashes", async () => {
    const h = await hashPassword("correct horse");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("correct horsf", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$99999999$8$1$aa$bb")).toBe(false);
  });

  it("limiter reserves, refunds and resets per window", () => {
    const l = new RateLimiter(2, 1000);
    expect(l.attempt("k", 0)).toBe(true);
    expect(l.attempt("k", 1)).toBe(true);
    expect(l.attempt("k", 2)).toBe(false);
    expect(l.attempt("other", 2)).toBe(true);
    l.refund("k", 3);
    expect(l.attempt("k", 4)).toBe(true);
    expect(l.attempt("k", 5)).toBe(false);
    expect(l.attempt("k", 1001)).toBe(true);
  });
});

describe("articles", () => {
  let tok: string;
  beforeEach(async () => {
    tok = (await signup("a@x.io")).token;
  });

  it("saves via server fetch (201), dedupes (200)", async () => {
    const r = await save(tok, { url: "https://example.com/post#frag", tags: ["Tech", "tech", " ai "] });
    expect(r.status).toBe(201);
    const a: Article = r.json;
    expect(a.url).toBe("https://example.com/post");
    expect(a.captureStatus).toBe("ok");
    expect(a.source).toBe("server");
    expect(a.favorite).toBe(false);
    expect(a.tags).toEqual(["ai", "Tech"]);
    expect(ex.fetchCalls).toEqual(["https://example.com/post"]);

    const d = await save(tok, { url: "https://example.com/post", tags: ["new"] });
    expect(d.status).toBe(200);
    expect(d.json.id).toBe(a.id);
    expect(d.json.tags).toEqual(["ai", "new", "Tech"]);
    expect(ex.fetchCalls).toHaveLength(1); // no refetch for duplicate
  });

  it("uses provided html without fetching; duplicate with html updates content", async () => {
    const r = await save(tok, { url: "https://e.com/a", html: "<p>first dom</p>" });
    expect(r.status).toBe(201);
    expect(r.json.source).toBe("extension");
    expect(r.json.title).toBe("From DOM");
    expect(ex.fetchCalls).toHaveLength(0);
    const r2 = await save(tok, { url: "https://e.com/a", html: "<p>second dom</p>" });
    expect(r2.status).toBe(200);
    expect(r2.json.id).toBe(r.json.id);
    expect(r2.json.textContent).toBe("second dom");
  });

  it("html extraction failure falls back to fetch", async () => {
    ex.failHtml = true;
    const r = await save(tok, { url: "https://e.com/b", html: "<p>x</p>" });
    expect(r.status).toBe(201);
    expect(r.json.captureStatus).toBe("ok");
    expect(ex.fetchCalls).toEqual(["https://e.com/b"]);
  });

  it("capture failure still saves the URL with failed status", async () => {
    ex.failFetch = true;
    const r = await save(tok, { url: "https://e.com/some/path?q=1" });
    expect(r.status).toBe(201);
    expect(r.json.captureStatus).toBe("failed");
    expect(r.json.captureError).toMatch(/network down/);
    expect(r.json.title).toBe("e.com/some/path");
    expect(r.json.contentHtml).toBe("");
    // retry on duplicate after failure, now succeeding
    ex.failFetch = false;
    const r2 = await save(tok, { url: "https://e.com/some/path?q=1" });
    expect(r2.status).toBe(200);
    expect(r2.json.id).toBe(r.json.id);
    expect(r2.json.captureStatus).toBe("ok");
    expect(r2.json.captureError).toBeNull();
  });

  it("failed refetch does not wipe good content", async () => {
    const r = await save(tok, { url: "https://e.com/c" });
    ex.failFetch = true;
    const rf = await call("POST", `/api/articles/${r.json.id}/refetch`, { token: tok });
    expect(rf.status).toBe(502);
    const g = await call("GET", `/api/articles/${r.json.id}`, { token: tok });
    expect(g.json.captureStatus).toBe("ok");
    expect(g.json.contentHtml).toContain("gardening");
    ex.failFetch = false;
    expect((await call("POST", `/api/articles/${r.json.id}/refetch`, { token: tok })).status).toBe(200);
  });

  it("validates input", async () => {
    expect((await save(tok, {})).status).toBe(400);
    expect((await save(tok, { url: "javascript:alert(1)" })).status).toBe(400);
    expect((await save(tok, { url: "file:///etc/passwd" })).status).toBe(400);
    expect((await save(tok, { url: "https://e.com", tags: "x" })).status).toBe(400);
    expect((await save(tok, { url: "https://e.com", source: "evil" })).status).toBe(400);
    expect((await save(tok, { url: "https://e.com", html: 5 })).status).toBe(400);
  });

  it("get/patch/delete with progress clamping", async () => {
    const { json: a } = await save(tok, { url: "https://e.com/p" });
    const g = await call("GET", `/api/articles/${a.id}`, { token: tok });
    expect(g.json.contentHtml).toContain("gardening");
    const p = await call("PATCH", `/api/articles/${a.id}`, {
      token: tok,
      body: { progress: 7, favorite: true, state: "archived", title: " New ", tags: ["x"] },
    });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({
      progress: 1,
      favorite: true,
      state: "archived",
      title: "New",
      tags: ["x"],
    });
    expect(
      (await call("PATCH", `/api/articles/${a.id}`, { token: tok, body: { progress: -3 } })).json.progress,
    ).toBe(0);
    expect(
      (await call("PATCH", `/api/articles/${a.id}`, { token: tok, body: { progress: "0.5" } })).status,
    ).toBe(400);
    expect(
      (await call("PATCH", `/api/articles/${a.id}`, { token: tok, body: { state: "deleted" } })).status,
    ).toBe(400);
    expect((await call("PATCH", `/api/articles/${a.id}`, { token: tok, body: { favorite: 1 } })).status).toBe(
      400,
    );
    expect((await call("DELETE", `/api/articles/${a.id}`, { token: tok })).status).toBe(204);
    expect((await call("GET", `/api/articles/${a.id}`, { token: tok })).status).toBe(404);
    expect((await call("DELETE", `/api/articles/${a.id}`, { token: tok })).status).toBe(404);
  });

  it("lists with filters and cursor pagination", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await save(tok, { url: `https://e.com/${i}`, tags: i % 2 ? ["odd"] : ["even"] });
      ids.push(r.json.id);
    }
    await call("PATCH", `/api/articles/${ids[0]}`, { token: tok, body: { state: "archived" } });
    await call("PATCH", `/api/articles/${ids[1]}`, { token: tok, body: { favorite: true } });

    const all = await call("GET", "/api/articles?limit=100", { token: tok });
    expect(all.json.items).toHaveLength(7);
    expect(all.json.items.every((a: Article) => a.contentHtml === "")).toBe(true);
    expect(all.json.nextCursor).toBeNull();

    expect((await call("GET", "/api/articles?state=inbox", { token: tok })).json.items).toHaveLength(6);
    expect(
      (await call("GET", "/api/articles?state=archived", { token: tok })).json.items.map(
        (a: Article) => a.id,
      ),
    ).toEqual([ids[0]]);
    expect(
      (await call("GET", "/api/articles?favorite=1", { token: tok })).json.items.map((a: Article) => a.id),
    ).toEqual([ids[1]]);
    expect((await call("GET", "/api/articles?tag=ODD", { token: tok })).json.items).toHaveLength(3);
    expect((await call("GET", "/api/articles?state=bogus", { token: tok })).status).toBe(400);
    expect((await call("GET", "/api/articles?cursor=%%%", { token: tok })).status).toBe(400);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page: any = (await call("GET", `/api/articles?limit=3${qs}`, { token: tok })).json;
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((a: Article) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("search with FTS and hostile query characters", async () => {
    await save(tok, {
      url: "https://e.com/s1",
      html: "<p>Growing tomatoes in a small garden &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    });
    await save(tok, { url: "https://e.com/s2", html: "<p>Rust ownership explained</p>" });
    const r = await call("GET", "/api/search?q=tomato", { token: tok });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].snippet).toContain("<mark>");
    for (const q of [
      '"',
      "'",
      "*",
      'tomatoes"',
      "a AND OR NOT",
      "NEAR(",
      "col:x",
      "^",
      "()",
      "-",
      "''\"\"**",
      "😀",
      "   ",
    ]) {
      const s = await call("GET", `/api/search?q=${encodeURIComponent(q)}`, { token: tok });
      expect(s.status, q).toBe(200);
      expect(Array.isArray(s.json.items)).toBe(true);
    }
    expect(
      (await call("GET", `/api/articles?q=${encodeURIComponent('"rust*')}`, { token: tok })).json.items,
    ).toHaveLength(1);
  });

  it("search snippets are HTML-escaped", async () => {
    await save(tok, {
      url: "https://e.com/x",
      html: "<p>keyword &lt;img src=x onerror=alert(1)&gt; here</p>",
    });
    const r = await call("GET", "/api/search?q=keyword", { token: tok });
    const snip: string = r.json.items[0].snippet;
    expect(snip).toContain("<mark>keyword</mark>");
    expect(snip).not.toContain("<img");
    expect(snip).toContain("&lt;img");
  });

  it("rejects URLs with credentials", async () => {
    expect((await save(tok, { url: "https://user:pass@e.com/x" })).status).toBe(400);
    expect((await save(tok, { url: "https://user@e.com/x" })).status).toBe(400);
    expect(normalizeUrl("https://:p@e.com/")).toBeNull();
    expect(normalizeUrl("https://e.com/a#b")).toBe("https://e.com/a");
    expect(ex.fetchCalls).toHaveLength(0);
  });

  it("ftsQuery sanitizes", () => {
    expect(ftsQuery('"); DROP TABLE x; --')).toBe('"DROP" "TABLE" "x"*');
    expect(ftsQuery("***")).toBeNull();
  });

  it("tag counts", async () => {
    await save(tok, { url: "https://e.com/1", tags: ["a", "b"] });
    await save(tok, { url: "https://e.com/2", tags: ["A"] });
    const r = await call("GET", "/api/tags", { token: tok });
    expect(r.json.tags).toEqual([
      { tag: "a", count: 2 },
      { tag: "b", count: 1 },
    ]);
  });

  it("tag casing is canonical per user (first-seen wins) and isolated between users", async () => {
    const one = await save(tok, { url: "https://e.com/c1", tags: ["Rust Lang"] });
    expect(one.json.tags).toEqual(["Rust Lang"]);
    const two = await save(tok, { url: "https://e.com/c2", tags: ["rust   LANG"] });
    expect(two.json.tags).toEqual(["Rust Lang"]);
    const p = await call("PATCH", `/api/articles/${two.json.id}`, {
      token: tok,
      body: { tags: ["RUST LANG", "new"] },
    });
    expect(p.json.tags).toEqual(["new", "Rust Lang"]);
    expect((await call("GET", "/api/tags", { token: tok })).json.tags).toEqual([
      { tag: "Rust Lang", count: 2 },
      { tag: "new", count: 1 },
    ]);
    // another user's casing is independent
    const other = await signup("b@x.io");
    const b = await save(other.token, { url: "https://e.com/c1", tags: ["rust lang"] });
    expect(b.json.tags).toEqual(["rust lang"]);
  });
});

describe("highlights", () => {
  it("CRUD", async () => {
    const { token } = await signup("a@x.io");
    const { json: a } = await save(token, { url: "https://e.com/h" });
    const c = await call("POST", `/api/articles/${a.id}/highlights`, {
      token,
      body: { quote: "tomatoes", prefix: "x".repeat(50), suffix: "after", note: "n" },
    });
    expect(c.status).toBe(201);
    const h: Highlight = c.json;
    expect(h).toMatchObject({ quote: "tomatoes", note: "n", color: "yellow", articleId: a.id });
    expect(h.prefix).toHaveLength(32);
    expect(
      (await call("POST", `/api/articles/${a.id}/highlights`, { token, body: { quote: "" } })).status,
    ).toBe(400);
    expect(
      (await call("POST", `/api/articles/${a.id}/highlights`, { token, body: { quote: "q", color: "red" } }))
        .status,
    ).toBe(400);

    expect((await call("GET", `/api/articles/${a.id}/highlights`, { token })).json.items).toHaveLength(1);
    const p = await call("PATCH", `/api/highlights/${h.id}`, { token, body: { color: "green", note: null } });
    expect(p.json).toMatchObject({ color: "green", note: null });
    const all = await call("GET", "/api/highlights", { token });
    expect(all.json.items[0]).toMatchObject({ id: h.id, articleTitle: a.title, articleUrl: a.url });
    expect((await call("DELETE", `/api/highlights/${h.id}`, { token })).status).toBe(204);
    expect((await call("GET", "/api/highlights", { token })).json.items).toHaveLength(0);

    // deleting the article cascades highlights
    await call("POST", `/api/articles/${a.id}/highlights`, { token, body: { quote: "q" } });
    await call("DELETE", `/api/articles/${a.id}`, { token });
    expect((await call("GET", "/api/highlights", { token })).json.items).toHaveLength(0);
  });
});

describe("user isolation (IDOR)", () => {
  it("user B cannot see or modify user A's data", async () => {
    const A = await signup("a@x.io");
    const B = await signup("b@x.io");
    const { json: art } = await save(A.token, { url: "https://e.com/secret", tags: ["private"] });
    const { json: hl } = await call("POST", `/api/articles/${art.id}/highlights`, {
      token: A.token,
      body: { quote: "secret quote" },
    });

    expect((await call("GET", `/api/articles/${art.id}`, { token: B.token })).status).toBe(404);
    expect(
      (
        await call("PATCH", `/api/articles/${art.id}`, {
          token: B.token,
          body: { title: "pwned", tags: ["x"] },
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", `/api/articles/${art.id}`, { token: B.token })).status).toBe(404);
    expect((await call("POST", `/api/articles/${art.id}/refetch`, { token: B.token })).status).toBe(404);
    expect((await call("GET", `/api/articles/${art.id}/highlights`, { token: B.token })).status).toBe(404);
    expect(
      (
        await call("POST", `/api/articles/${art.id}/highlights`, {
          token: B.token,
          body: { quote: "inject" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("PATCH", `/api/highlights/${hl.id}`, { token: B.token, body: { note: "pwned" } })).status,
    ).toBe(404);
    expect((await call("DELETE", `/api/highlights/${hl.id}`, { token: B.token })).status).toBe(404);

    expect((await call("GET", "/api/articles", { token: B.token })).json.items).toHaveLength(0);
    expect((await call("GET", "/api/highlights", { token: B.token })).json.items).toHaveLength(0);
    expect((await call("GET", "/api/search?q=gardening", { token: B.token })).json.items).toHaveLength(0);
    expect((await call("GET", "/api/tags", { token: B.token })).json.tags).toHaveLength(0);

    // B saving the same URL gets their own copy (201), not A's
    const bSave = await save(B.token, { url: "https://e.com/secret" });
    expect(bSave.status).toBe(201);
    expect(bSave.json.id).not.toBe(art.id);
    expect(bSave.json.tags).toEqual([]);

    // A's data untouched
    const a = await call("GET", `/api/articles/${art.id}`, { token: A.token });
    expect(a.json.title).not.toBe("pwned");
    expect(a.json.tags).toEqual(["private"]);
    const ah = await call("GET", `/api/articles/${art.id}/highlights`, { token: A.token });
    expect(ah.json.items).toHaveLength(1);
    expect(ah.json.items[0].note).toBeNull();
    expect((await call("GET", "/api/search?q=gardening", { token: A.token })).json.items).toHaveLength(1);
  });
});

describe("misc", () => {
  it("unknown api route -> json 404", async () => {
    const r = await call("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not found");
  });
});
