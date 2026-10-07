import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createGzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  ExtractError,
  extractFromHtml,
  fetchAndExtract,
  isPrivateIp,
  pinnedRequest,
  type LookupFn,
} from "./extract.ts";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(
  routes: Record<string, Handler | Handler[]>,
): typeof fetch & { calls: { url: string; ua: string; redirect: string }[] } {
  const calls: { url: string; ua: string; redirect: string }[] = [];
  const counters: Record<string, number> = {};
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, ua: headers.get("user-agent") ?? "", redirect: String(init.redirect) });
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404 });
    const i = counters[url] ?? 0;
    counters[url] = i + 1;
    const h = Array.isArray(r) ? r[Math.min(i, r.length - 1)] : r;
    return h(url, init);
  }) as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}
const html = (body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...extra } });
const redirect = (to: string, status = 301): Response =>
  new Response(null, { status, headers: { location: to } });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    expect(e).toBeInstanceOf(ExtractError);
    return (e as ExtractError).code;
  }
}

describe("extractFromHtml", () => {
  it("normal blog: readability + metadata + canonical", () => {
    const r = extractFromHtml(fx("blog.html"), "https://jane.example/posts/plain-text?utm=x");
    expect(r.url).toBe("https://jane.example/posts/plain-text");
    expect(r.title).toBe("Why Plain Text Wins");
    expect(r.author).toBe("Jane Doe");
    expect(r.siteName).toBe("Jane's Blog");
    expect(r.publishedAt).toBe("2024-03-05T10:00:00.000Z");
    expect(r.leadImage).toBe("https://jane.example/images/cover.jpg");
    expect(r.excerpt).toBe("A short essay on durable formats.");
    expect(r.textContent).toContain("Plain text survives every migration");
    expect(r.textContent).not.toContain("Copyright Jane");
    expect(r.contentHtml).toContain('src="https://jane.example/images/diagram.png"');
    expect(r.contentHtml).toContain('href="https://jane.example/posts/other"');
    expect(r.contentHtml).not.toContain("javascript:");
    expect(r.contentHtml).toContain("<pre>");
    expect(r.wordCount).toBeGreaterThan(80);
  });

  it("news site with JSON-LD-only body", () => {
    const r = extractFromHtml(fx("news-jsonld.html"), "https://news.example/bike-lanes");
    expect(r.textContent).toContain("voted 7-2");
    expect(r.textContent).toContain("Construction is expected");
    expect(r.contentHtml.match(/<p>/g)?.length).toBe(3);
    expect(r.author).toBe("Lois Lane");
    expect(r.publishedAt).toBe("2024-06-01T12:30:00.000Z");
    expect(r.leadImage).toBe("https://news.example/img/lanes.jpg");
    expect(r.siteName).toBe("Daily Planet");
    expect(r.title).toMatch(/City Council Approves Bike Lanes/);
    expect(r.textContent).not.toContain("Loading");
  });

  it("lazy images are resolved", () => {
    const r = extractFromHtml(fx("lazy.html"), "https://photos.example/gallery/");
    expect(r.contentHtml).toContain("https://photos.example/photos/one.jpg");
    expect(r.contentHtml).toContain("https://cdn.example/two.jpg");
    expect(r.contentHtml).toContain("https://photos.example/photos/three-1x.jpg");
    expect(r.contentHtml).not.toContain("data:image");
  });

  it("script-heavy page: falls back without leaking scripts or handlers", () => {
    const r = extractFromHtml(fx("script-heavy.html"), "https://scripts.example/page");
    expect(r.textContent).toContain("Short visible text here.");
    expect(r.textContent).toContain("A page that is mostly scripts");
    expect(r.contentHtml).not.toMatch(/<script|tracker|onclick|onload|alert|steal|ads\.example|injected/i);
    expect(r.title).toBe("Script Heavy");
  });

  it("title falls back to hostname; empty page throws empty", () => {
    const r = extractFromHtml(
      "<html><body><p>Just a little text.</p></body></html>",
      "https://host.example/x",
    );
    expect(r.title).toBe("host.example");
    expect(r.textContent).toBe("Just a little text.");
    expect(() =>
      extractFromHtml("<html><body><script>x()</script></body></html>", "https://host.example/"),
    ).toThrow(ExtractError);
    try {
      extractFromHtml("<html><body></body></html>", "https://host.example/");
    } catch (e) {
      expect((e as ExtractError).code).toBe("empty");
    }
  });
});

describe("fetchAndExtract", () => {
  const blog = fx("blog.html");

  it("sends browser-like headers and follows redirects manually", async () => {
    const f = fakeFetch({
      "https://short.example/x": () => redirect("https://jane.example/tmp", 302),
      "https://jane.example/tmp": () => redirect("/posts/plain-text"),
      "https://jane.example/posts/plain-text": () => html(blog),
    });
    const r = await fetchAndExtract("https://short.example/x", { fetch: f, lookup: publicLookup });
    expect(r.title).toBe("Why Plain Text Wins");
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://short.example/x",
      "https://jane.example/tmp",
      "https://jane.example/posts/plain-text",
    ]);
    expect(f.calls.every((c) => c.redirect === "manual" && /Mozilla\/5\.0 \(Macintosh/.test(c.ua))).toBe(
      true,
    );
  });

  it("gives up after too many redirects", async () => {
    const f = fakeFetch({ "https://loop.example/": () => redirect("https://loop.example/") });
    expect(await codeOf(fetchAndExtract("https://loop.example/", { fetch: f, lookup: publicLookup }))).toBe(
      "fetch",
    );
    expect(f.calls.length).toBe(6);
  });

  it("retries once on 5xx with a Googlebot UA", async () => {
    const f = fakeFetch({
      "https://flaky.example/": [() => new Response("err", { status: 503 }), () => html(blog)],
    });
    const r = await fetchAndExtract("https://flaky.example/", { fetch: f, lookup: publicLookup });
    expect(r.textContent).toContain("Plain text survives");
    expect(f.calls.length).toBe(2);
    expect(f.calls[1].ua).toMatch(/Googlebot/);
  });

  it("retries once on network error, then reports fetch", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await codeOf(fetchAndExtract("https://down.example/", { fetch: f, lookup: publicLookup }))).toBe(
      "fetch",
    );
    expect(n).toBe(2);
  });

  it("persistent 5xx -> http; 404 -> http without retry", async () => {
    const f = fakeFetch({ "https://dead.example/": () => new Response("x", { status: 500 }) });
    expect(await codeOf(fetchAndExtract("https://dead.example/", { fetch: f, lookup: publicLookup }))).toBe(
      "http",
    );
    expect(f.calls.length).toBe(2);
    const g = fakeFetch({});
    expect(
      await codeOf(fetchAndExtract("https://missing.example/", { fetch: g, lookup: publicLookup })),
    ).toBe("http");
    expect(g.calls.length).toBe(1);
  });

  it("times out via AbortSignal", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(
      await codeOf(
        fetchAndExtract("https://slow.example/", { fetch: f, timeoutMs: 50, lookup: publicLookup }),
      ),
    ).toBe("fetch");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("times out even if fetch ignores the signal", async () => {
    const f = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    expect(
      await codeOf(
        fetchAndExtract("https://hang.example/", { fetch: f, timeoutMs: 30, lookup: publicLookup }),
      ),
    ).toBe("fetch");
  });

  it("rejects PDFs and other non-HTML", async () => {
    const f = fakeFetch({
      "https://docs.example/a.pdf": () =>
        new Response("%PDF-1.7 ...", { headers: { "content-type": "application/pdf" } }),
      "https://docs.example/b": () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])),
    });
    expect(
      await codeOf(fetchAndExtract("https://docs.example/a.pdf", { fetch: f, lookup: publicLookup })),
    ).toBe("not_html");
    expect(await codeOf(fetchAndExtract("https://docs.example/b", { fetch: f, lookup: publicLookup }))).toBe(
      "not_html",
    );
  });

  it("decodes non-UTF-8 charsets from header and meta", async () => {
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode("<html><head><title>Caf"),
      0xe9,
      ...new TextEncoder().encode("</title></head><body><p>Un caf"),
      0xe9,
      ...new TextEncoder().encode(" noir.</p></body></html>"),
    ]);
    const f = fakeFetch({
      "https://fr.example/h": () =>
        new Response(latin1, { headers: { "content-type": "text/html; charset=iso-8859-1" } }),
      "https://fr.example/m": () =>
        new Response(
          new Uint8Array([
            ...new TextEncoder().encode('<html><head><meta charset="windows-1252">'),
            ...latin1.subarray(12),
          ]),
          { headers: { "content-type": "text/html" } },
        ),
    });
    expect(
      (await fetchAndExtract("https://fr.example/h", { fetch: f, lookup: publicLookup })).textContent,
    ).toContain("Un café noir.");
    expect((await fetchAndExtract("https://fr.example/m", { fetch: f, lookup: publicLookup })).title).toBe(
      "Café",
    );
  });

  it("uses the AMP version when the main extraction is weak", async () => {
    const shell = `<html><head><title>Story</title><link rel="canonical" href="https://amp.example/story"><link rel="amphtml" href="/story.amp"></head><body><div id="app">Loading</div></body></html>`;
    const f = fakeFetch({
      "https://amp.example/story": () => html(shell),
      "https://amp.example/story.amp": () => html(blog),
    });
    const r = await fetchAndExtract("https://amp.example/story", { fetch: f, lookup: publicLookup });
    expect(r.url).toBe("https://amp.example/story");
    expect(r.textContent).toContain("Plain text survives every migration");
  });

  it("keeps primary result if AMP fetch fails", async () => {
    const shell = `<html><head><title>Story</title><link rel="amphtml" href="https://amp.example/gone"></head><body><p>Teaser only.</p></body></html>`;
    const f = fakeFetch({ "https://amp.example/s": () => html(shell) });
    const r = await fetchAndExtract("https://amp.example/s", { fetch: f, lookup: publicLookup });
    expect(r.textContent).toBe("Teaser only.");
  });
});

describe("SSRF policy", () => {
  it("classifies private and public IPs", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "2002:7f00:1::",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of [
      "93.184.216.34",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("rejects bad schemes, credentials, localhost, private literals and private DNS answers", async () => {
    const priv: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    expect(await codeOf(assertPublicUrl("file:///etc/passwd", { lookup: publicLookup }))).toBe("fetch");
    expect(await codeOf(assertPublicUrl("https://user:pw@example.com/", { lookup: publicLookup }))).toBe(
      "fetch",
    );
    expect(await codeOf(assertPublicUrl("http://localhost:4800/", { lookup: publicLookup }))).toBe("fetch");
    expect(await codeOf(assertPublicUrl("http://127.1/", { lookup: publicLookup }))).toBe("fetch");
    expect(await codeOf(assertPublicUrl("http://2130706433/", { lookup: publicLookup }))).toBe("fetch");
    expect(await codeOf(assertPublicUrl("http://[::ffff:169.254.169.254]/", { lookup: publicLookup }))).toBe(
      "fetch",
    );
    expect(await codeOf(assertPublicUrl("http://internal.example/", { lookup: priv }))).toBe("fetch");
    expect((await assertPublicUrl("https://example.com/a", { lookup: publicLookup })).href).toBe(
      "https://example.com/a",
    );
    expect((await assertPublicUrl("http://10.0.0.5/", { allowPrivate: true })).hostname).toBe("10.0.0.5");
  });

  it("re-validates every redirect hop and the AMP URL", async () => {
    const f = fakeFetch({
      "https://pub.example/": () => redirect("http://169.254.169.254/latest/meta-data/"),
    });
    expect(await codeOf(fetchAndExtract("https://pub.example/", { fetch: f, lookup: publicLookup }))).toBe(
      "fetch",
    );
    expect(f.calls.map((c) => c.url)).toEqual(["https://pub.example/"]);

    const shell = `<html><head><title>S</title><link rel="amphtml" href="http://192.168.0.1/amp"></head><body><p>Teaser.</p></body></html>`;
    const g = fakeFetch({ "https://pub.example/s": () => html(shell) });
    const r = await fetchAndExtract("https://pub.example/s", { fetch: g, lookup: publicLookup });
    expect(r.textContent).toBe("Teaser.");
    expect(g.calls.some((c) => c.url.includes("192.168"))).toBe(false);
  });

  it("allowPrivate opts out", async () => {
    const f = fakeFetch({ "http://10.0.0.5/": () => html(blog()) });
    const r = await fetchAndExtract("http://10.0.0.5/", { fetch: f, allowPrivate: true });
    expect(r.title).toBe("Why Plain Text Wins");
    function blog(): string {
      return fx("blog.html");
    }
  });
});

describe("fix round regressions", () => {
  it("DNS validation is inside the timeout", async () => {
    const hang: LookupFn = () => new Promise(() => undefined);
    const f = fakeFetch({});
    const t0 = Date.now();
    expect(
      await codeOf(fetchAndExtract("https://slowdns.example/", { fetch: f, lookup: hang, timeoutMs: 50 })),
    ).toBe("fetch");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(f.calls.length).toBe(0);
  });

  it("size cap applies to injected fetch bodies and declared content-length", async () => {
    const big = "<html><body><p>" + "z".repeat(5000) + "</p></body></html>";
    const f = fakeFetch({
      "https://big.example/": () => html(big),
      "https://big.example/declared": () => html("<p>x</p>", { "content-length": "999999999" }),
    });
    expect(
      await codeOf(
        fetchAndExtract("https://big.example/", { fetch: f, lookup: publicLookup, maxBytes: 1000 }),
      ),
    ).toBe("http");
    expect(
      await codeOf(fetchAndExtract("https://big.example/declared", { fetch: f, lookup: publicLookup })),
    ).toBe("http");
    expect(f.calls.length).toBe(2);
  });

  it("empty main page still falls back to AMP", async () => {
    const shell = `<html><head><title>T</title><link rel="amphtml" href="/a.amp"></head><body><div id="app"></div><script>x()</script></body></html>`;
    const f = fakeFetch({
      "https://spa.example/a": () => html(shell),
      "https://spa.example/a.amp": () => html(fx("blog.html")),
    });
    const r = await fetchAndExtract("https://spa.example/a", { fetch: f, lookup: publicLookup });
    expect(r.textContent).toContain("Plain text survives every migration");
    const g = fakeFetch({ "https://spa.example/a": () => html(shell) });
    expect(await codeOf(fetchAndExtract("https://spa.example/a", { fetch: g, lookup: publicLookup }))).toBe(
      "empty",
    );
  });

  describe("pinned node transport", () => {
    let server: Server;
    let port = 0;
    const seen: IncomingHttpHeaders[] = [];
    const closes: string[] = [];
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20));
    const waitClosed = async (path: string): Promise<void> => {
      const t0 = Date.now();
      while (!closes.includes(path)) {
        if (Date.now() - t0 > 2000) throw new Error(`server connection for ${path} never closed`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const sig = (): AbortSignal => new AbortController().signal;
    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push(req.headers);
        const closed = (): void => {
          closes.push(req.url ?? "");
        };
        res.on("close", closed);
        if (req.url === "/endless-redirect") {
          res.writeHead(302, { location: "/plain" });
          const t = setInterval(() => res.write("x".repeat(1024)), 5);
          res.on("close", () => clearInterval(t));
        } else if (req.url === "/endless-gzip") {
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          const gz = createGzip();
          gz.pipe(res);
          const t = setInterval(() => {
            gz.write("<p>" + "y".repeat(1024) + "</p>");
            gz.flush(); // emit compressed bytes now so the client sees a live stream
          }, 5);
          res.on("close", () => {
            clearInterval(t);
            gz.destroy();
          });
        } else if (req.url === "/bad-gzip") {
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          res.write(Buffer.from("this is definitely not gzip data"));
          // never end: only the client tearing down the socket closes it
        } else if (req.url === "/bomb") {
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          res.end(bomb);
        } else if (req.url === "/redir") {
          res.writeHead(302, { location: "/gz" });
          res.end();
        } else if (req.url === "/gz") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
          res.end(gzipSync(fx("blog.html")));
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("pinned ok");
        }
      });
      for (let p = 4870; p < 4900 && !port; p++) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(p, "127.0.0.1", () => {
              server.off("error", reject);
              resolve();
            });
          });
          port = p;
        } catch {
          // port busy; try the next one in the allowed 4800-4899 range
        }
      }
      if (!port) throw new Error("no free port in 4870-4899");
    });
    afterAll(
      () =>
        new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
    );

    it("connects to the pinned address without re-resolving, keeping the Host header", async () => {
      // ".invalid" never resolves in DNS: success proves the connection used the pinned address.
      const res = await pinnedRequest(
        `http://rebind.invalid:${port}/plain`,
        { headers: { "User-Agent": "t" }, signal: new AbortController().signal },
        [{ address: "127.0.0.1", family: 4 }],
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("pinned ok");
      expect(seen.at(-1)?.host).toBe(`rebind.invalid:${port}`);
    });

    it("default transport follows redirects manually and decompresses gzip", async () => {
      const r = await fetchAndExtract(`http://127.0.0.1:${port}/redir`, { allowPrivate: true });
      expect(r.title).toBe("Why Plain Text Wins");
      expect(seen.at(-1)?.["accept-encoding"]).toContain("gzip");
    });

    it("discarded redirect bodies are destroyed, not drained", async () => {
      const res = await pinnedRequest(
        `http://127.0.0.1:${port}/endless-redirect`,
        { headers: {}, signal: sig() },
        null,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/plain");
      await waitClosed("/endless-redirect");
    });

    it("cancelling a decompressed body closes the upstream connection", async () => {
      const res = await pinnedRequest(
        `http://127.0.0.1:${port}/endless-gzip`,
        { headers: {}, signal: sig() },
        null,
      );
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await waitClosed("/endless-gzip");
    });

    it("decoder errors propagate to the response and close the socket", async () => {
      const res = await pinnedRequest(
        `http://127.0.0.1:${port}/bad-gzip`,
        { headers: {}, signal: sig() },
        null,
      );
      await expect(res.arrayBuffer()).rejects.toThrow();
      await waitClosed("/bad-gzip");
    });

    it("caps decompressed size (gzip bomb) and closes the connection", async () => {
      const e = await fetchAndExtract(`http://127.0.0.1:${port}/bomb`, { allowPrivate: true }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ExtractError);
      expect((e as ExtractError).code).toBe("http");
      expect((e as ExtractError).message).toMatch(/too large/);
      await waitClosed("/bomb");
      const small = await fetchAndExtract(`http://127.0.0.1:${port}/endless-gzip`, {
        allowPrivate: true,
        maxBytes: 64 * 1024,
      }).catch((x: unknown) => x);
      expect((small as ExtractError).code).toBe("http");
    });

    it("default transport still blocks private targets without allowPrivate", async () => {
      expect(await codeOf(fetchAndExtract(`http://127.0.0.1:${port}/plain`))).toBe("fetch");
    });
  });
});
