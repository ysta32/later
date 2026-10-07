import { describe, expect, it } from "vitest";
import { countWords, htmlToText, sanitizeHtml } from "./sanitize.ts";

const BASE = "https://example.com/blog/post";

describe("sanitizeHtml", () => {
  it("removes scripts, styles, event handlers and javascript: URLs", () => {
    const out = sanitizeHtml(
      `<p onclick="alert(1)" style="color:red">Hi<script>alert(2)</script></p><style>p{}</style>
       <a href="javascript:alert(3)">x</a><a href="JaVaScRiPt:alert(4)">y</a><img src="x.png" onerror="alert(5)">
       <svg onload="alert(6)"><script>alert(7)</script></svg><form><input value="z"></form>`,
      BASE,
    );
    expect(out).not.toMatch(
      /script|alert|onclick|onerror|onload|style=|<style|javascript:|<svg|<form|<input/i,
    );
    expect(out).toContain("Hi");
    expect(out).toContain('src="https://example.com/blog/x.png"');
  });

  it("absolutizes href/src/srcset and keeps fragments", () => {
    const out = sanitizeHtml(
      `<a href="/a">a</a><a href="../b">b</a><a href="#top">t</a><a href="//cdn.example/c">c</a>
       <img src="i.jpg" srcset="i-1x.jpg 1x, /i-2x.jpg 2x">`,
      BASE,
    );
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('href="https://example.com/b"');
    expect(out).toContain('href="#top"');
    expect(out).toContain('href="https://cdn.example/c"');
    expect(out).toContain('srcset="https://example.com/blog/i-1x.jpg 1x, https://example.com/i-2x.jpg 2x"');
  });

  it("keeps youtube/vimeo iframes only", () => {
    const out = sanitizeHtml(
      `<iframe src="https://www.youtube.com/embed/abc"></iframe><iframe src="https://player.vimeo.com/video/1"></iframe>
       <iframe src="https://evil.example/frame"></iframe><iframe src="/local"></iframe><iframe src="javascript:alert(1)"></iframe>`,
      BASE,
    );
    expect(out).toContain("https://www.youtube.com/embed/abc");
    expect(out).toContain("https://player.vimeo.com/video/1");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("local");
    expect(out.match(/<iframe/g)?.length).toBe(2);
  });

  it("keeps figure/img/pre/code/table/blockquote and language classes", () => {
    const out = sanitizeHtml(
      `<figure><img src="/a.png" alt="A"><figcaption>Cap</figcaption></figure>
       <pre><code class="language-ts evil">x</code></pre><table><tr><td colspan="2">c</td></tr></table>
       <blockquote>q</blockquote>`,
      BASE,
    );
    for (const t of [
      "<figure>",
      "<img",
      "<figcaption>",
      "<pre>",
      '<code class="language-ts">',
      "<table>",
      'colspan="2"',
      "<blockquote>",
    ]) {
      expect(out).toContain(t);
    }
  });

  it("fixes lazy-loaded images", () => {
    const out = sanitizeHtml(
      `<img src="data:image/gif;base64,R0lGOD" data-src="/real.jpg">
       <img data-original="https://cdn.example/two.jpg">
       <img src="/blank.gif" data-srcset="/three.jpg 1x, /three@2x.jpg 2x">
       <img alt="nothing">`,
      BASE,
    );
    expect(out).toContain('src="https://example.com/real.jpg"');
    expect(out).toContain('src="https://cdn.example/two.jpg"');
    expect(out).toContain('src="https://example.com/three.jpg"');
    expect(out).toContain('srcset="https://example.com/three.jpg 1x, https://example.com/three@2x.jpg 2x"');
    expect(out).not.toContain("data-src");
    expect(out).not.toContain("nothing");
  });

  it("does not let data: URLs through links", () => {
    const out = sanitizeHtml(`<a href="data:text/html,<script>alert(1)</script>">x</a>`, BASE);
    expect(out).not.toContain("data:");
  });
});

describe("htmlToText / countWords", () => {
  it("separates blocks and drops scripts", () => {
    const t = htmlToText(
      "<h1>Title</h1><p>One <b>two</b></p><script>bad()</script><ul><li>a</li><li>b</li></ul>",
    );
    expect(t).toBe("Title\n\nOne two\n\na\n\nb");
  });
  it("decodes entities", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
  });
  it("counts words incl. CJK", () => {
    expect(countWords("Hello, world! It's 2024.")).toBe(4);
    expect(countWords("")).toBe(0);
    expect(countWords("日本語 text")).toBe(4);
  });
});
