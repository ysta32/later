import { describe, expect, it } from "vitest";
import { parseFeed } from "./feeds.ts";

const feedUrl = "https://example.com/news/feed.xml";

describe("parseFeed", () => {
  it("parses RSS and prefers encoded content over the description", () => {
    const result = parseFeed(
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><title>News &amp; Notes</title><item><guid isPermaLink="false">001</guid>
      <link>https://example.com/story</link><title>First story</title>
      <description>Teaser</description><content:encoded><![CDATA[<p>Full story</p>]]></content:encoded>
      <pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`,
      feedUrl,
    );
    expect(result).toEqual({
      title: "News & Notes",
      items: [
        {
          guid: "001",
          url: "https://example.com/story",
          title: "First story",
          contentHtml: "<p>Full story</p>",
          publishedAt: "2026-10-07T12:00:00.000Z",
        },
      ],
    });
  });

  it("resolves RSS links and falls back to URL, description, and null metadata", () => {
    const result = parseFeed(
      `<rss><channel><title>Feed</title>
      <item><link>../one</link><description><![CDATA[<p>Summary</p>]]></description></item>
      <item><link>/two</link><pubDate>not a date</pubDate></item>
      </channel></rss>`,
      feedUrl,
    );
    expect(result.items).toEqual([
      {
        guid: "https://example.com/one",
        url: "https://example.com/one",
        title: "",
        contentHtml: "<p>Summary</p>",
        publishedAt: null,
      },
      {
        guid: "https://example.com/two",
        url: "https://example.com/two",
        title: "",
        contentHtml: null,
        publishedAt: null,
      },
    ]);
  });

  it("parses Atom, selecting the alternate link and preferring content", () => {
    const result = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry>
      <id>tag:example.com,2026:1</id><title>Entry</title><link rel="self" href="/api/1"/>
      <link rel="alternate" href="../article"/><content type="html">&lt;p&gt;Content&lt;/p&gt;</content>
      <summary>Summary</summary><published>2026-10-07T12:00:00Z</published>
      </entry></feed>`,
      feedUrl,
    );
    expect(result).toEqual({
      title: "Atom",
      items: [
        {
          guid: "tag:example.com,2026:1",
          url: "https://example.com/article",
          title: "Entry",
          contentHtml: "<p>Content</p>",
          publishedAt: "2026-10-07T12:00:00.000Z",
        },
      ],
    });
  });

  it("handles namespaced Atom, implicit alternate links, summaries and updated dates", () => {
    const result = parseFeed(
      `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry>
      <atom:link href="story"/><atom:summary>1 &lt; 2</atom:summary>
      <atom:updated>2026-10-07T00:00:00Z</atom:updated></atom:entry></atom:feed>`,
      feedUrl,
    );
    expect(result.items[0]).toEqual({
      guid: "https://example.com/news/story",
      url: "https://example.com/news/story",
      title: "",
      contentHtml: "1 &lt; 2",
      publishedAt: "2026-10-07T00:00:00.000Z",
    });
  });

  it("preserves Atom XHTML content markup", () => {
    const result = parseFeed(
      `<feed><entry><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello</p></div></content></entry></feed>`,
      feedUrl,
    );
    expect(result.items[0].contentHtml).toContain("<p>Hello</p>");
  });

  it.each(["content", "summary"])("preserves mixed-content order in Atom XHTML %s", (element) => {
    const result = parseFeed(
      `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:title>First</atom:title></atom:entry><atom:entry><atom:${element} type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Before <strong>bold</strong> after <em>one</em> between <em>two &amp; three</em> end.</p></div></atom:${element}></atom:entry></atom:feed>`,
      feedUrl,
    );
    expect(result.items[1].contentHtml).toContain(
      "<p>Before <strong>bold</strong> after <em>one</em> between <em>two &amp; three</em> end.</p>",
    );
  });

  it("parses JSON Feed HTML and text content with relative URLs", () => {
    const result = parseFeed(
      `  ${JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON",
        items: [
          {
            id: "001",
            url: "../one",
            title: "One",
            content_html: "<p>One</p>",
            content_text: "Fallback",
            date_published: "2026-10-07T12:00:00Z",
          },
          { external_url: "/two", content_text: "A < B & C" },
          { url: "/three" },
        ],
      })}`,
      feedUrl,
    );
    expect(result.title).toBe("JSON");
    expect(result.items).toEqual([
      {
        guid: "001",
        url: "https://example.com/one",
        title: "One",
        contentHtml: "<p>One</p>",
        publishedAt: "2026-10-07T12:00:00.000Z",
      },
      {
        guid: "https://example.com/two",
        url: "https://example.com/two",
        title: "",
        contentHtml: "A &lt; B &amp; C",
        publishedAt: null,
      },
      {
        guid: "https://example.com/three",
        url: "https://example.com/three",
        title: "",
        contentHtml: null,
        publishedAt: null,
      },
    ]);
  });

  it.each(["<rss><channel/></rss>", "<feed/>", '{"title":"Empty","items":[]}'])(
    "accepts empty feeds: %s",
    (source) => {
      expect(parseFeed(source, feedUrl).items).toEqual([]);
    },
  );

  it("rejects malformed and unsupported inputs", () => {
    for (const source of ["<rss>", "<document/>", "{invalid"]) {
      expect(() => parseFeed(source, feedUrl)).toThrow();
    }
  });

  it("does not expose unsafe article URL schemes", () => {
    expect(
      parseFeed("<rss><channel><item><link>javascript:alert(1)</link></item></channel></rss>", feedUrl)
        .items[0].url,
    ).toBe("");
  });
});
