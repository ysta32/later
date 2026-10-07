import { describe, expect, it } from "vitest";
import { parseInbound } from "./email.ts";

const envelope = {
  to: "save+abc123@inbound.example",
  from: '"Daily News" <editor@example.com>',
  subject: "Today's news",
};

describe("parseInbound", () => {
  it.each([
    ["save+abc123@inbound.example", "abc123"],
    ["abc123@inbound.example", "abc123"],
    ['"Reading List" <save+abc123@inbound.example>', "abc123"],
    ["Other <other@example.com>, Save <save+abc123@inbound.example>", "abc123"],
    ['"person@example.com" <abc123@inbound.example>', "abc123"],
    ["save+token-with_123@inbound.example", "token-with_123"],
    ["save+@inbound.example", null],
    ["not an address", null],
  ])("parses the inbound token from %s", (to, token) => {
    expect(parseInbound({ ...envelope, to, text: "Hello" }).inboundToken).toBe(token);
  });

  it("recognizes a single forwarded link with a short note", () => {
    expect(
      parseInbound({ ...envelope, text: "Read this: https://example.com/story?x=1&y=2\nThanks!" }),
    ).toEqual({ inboundToken: "abc123", url: "https://example.com/story?x=1&y=2", extracted: null });
  });

  it.each([
    [
      "https://en.wikipedia.org/wiki/Example_(disambiguation)",
      "https://en.wikipedia.org/wiki/Example_(disambiguation)",
    ],
    [
      "(https://en.wikipedia.org/wiki/Example_(disambiguation)).",
      "https://en.wikipedia.org/wiki/Example_(disambiguation)",
    ],
    ["https://example.com/a_(b_(c)).", "https://example.com/a_(b_(c))"],
    ["(https://example.com/story).", "https://example.com/story"],
    ["[https://example.com/story],", "https://example.com/story"],
  ])("preserves URL parentheses while trimming prose punctuation: %s", (text, url) => {
    expect(parseInbound({ ...envelope, text: `Read ${text}` })).toEqual({
      inboundToken: "abc123",
      url,
      extracted: null,
    });
  });

  it("preserves a substantial HTML newsletter with a short browser-link text alternative", () => {
    const article = "This newsletter contains the complete story and useful details. ".repeat(10).trim();
    const html = `<p>${article}</p><a href="https://example.com/newsletter">View in browser</a>`;
    const result = parseInbound({
      ...envelope,
      text: "View in browser: https://example.com/newsletter",
      html,
    });
    expect(result.url).toBeNull();
    expect(result.extracted?.contentHtml).toContain(`<p>${article}</p>`);
    expect(result.extracted?.textContent).toContain(article);
  });

  it("recognizes an HTML link even if its label is not the URL", () => {
    expect(
      parseInbound({
        ...envelope,
        html: '<p>Read <a href="https://example.com/story?a=1&amp;b=2">this story</a>.</p>',
      }).url,
    ).toBe("https://example.com/story?a=1&b=2");
  });

  it("deduplicates a URL occurring in both text and an HTML anchor", () => {
    expect(
      parseInbound({
        ...envelope,
        text: "https://example.com/story",
        html: '<a href="https://example.com/story">https://example.com/story</a>',
      }).extracted,
    ).toBeNull();
  });

  it("treats multiple links or substantial surrounding text as a newsletter", () => {
    expect(
      parseInbound({ ...envelope, text: "https://example.com/one https://example.com/two" }).url,
    ).toBeNull();
    expect(
      parseInbound({ ...envelope, text: `${"a".repeat(300)} https://example.com/one` }).extracted,
    ).not.toBeNull();
  });

  it("extracts and sanitizes an HTML newsletter, removing tracking pixels", () => {
    const result = parseInbound({
      ...envelope,
      html: `<h1>Welcome</h1><p>The latest news is here.</p>
      <script>alert('bad')</script><img src="https://example.com/pixel" width="1" height="1">
      <img src="https://example.com/css-pixel" style="width: 1px; height: 1px">
      <img src="https://example.com/photo" width="600" height="400" onerror="alert(1)">`,
    });
    expect(result.url).toBeNull();
    expect(result.extracted).toMatchObject({
      url: "",
      title: "Today's news",
      author: "Daily News",
      siteName: "example.com",
      textContent: "Welcome The latest news is here.",
      wordCount: 6,
      leadImage: null,
      publishedAt: null,
    });
    expect(result.extracted?.contentHtml).toContain("<h1>Welcome</h1>");
    expect(result.extracted?.contentHtml).toContain("https://example.com/photo");
    expect(result.extracted?.contentHtml).not.toMatch(/pixel|script|onerror|alert/);
  });

  it("escapes text-only newsletters and preserves paragraph boundaries", () => {
    const result = parseInbound({
      ...envelope,
      from: "editor@Example.COM",
      text: "Hello <reader> & friends.\n\nSecond paragraph.\nNext line.",
    });
    expect(result.extracted).toMatchObject({
      author: null,
      siteName: "example.com",
      wordCount: 8,
      textContent: "Hello <reader> & friends. Second paragraph. Next line.",
    });
    expect(result.extracted?.contentHtml).toContain("&lt;reader&gt; &amp; friends.");
    expect(result.extracted?.contentHtml).toContain("</p><p>");
  });

  it("handles missing bodies and sender metadata", () => {
    expect(parseInbound({ to: "", from: "", subject: "" })).toMatchObject({
      inboundToken: null,
      url: null,
      extracted: { author: null, siteName: null, textContent: "", wordCount: 0, excerpt: null },
    });
  });

  it("does not classify non-HTTP links as forwarded URLs", () => {
    expect(parseInbound({ ...envelope, html: '<a href="javascript:alert(1)">Bad link</a>' }).url).toBeNull();
  });
});
