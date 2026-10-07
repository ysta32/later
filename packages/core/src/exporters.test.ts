import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { articleToMarkdown, buildEpub, exportJson, markdownZip } from "./exporters.ts";
import type { Article, ExportBundle, Highlight } from "./types.ts";

const article: Article = {
  id: "abcdef123456",
  userId: "user",
  url: "https://example.com/?a=1&b=2",
  title: 'Café: "Ideas" & More',
  author: "A: B\nC",
  siteName: "Example",
  excerpt: null,
  contentHtml:
    '<h2>Heading</h2><p>A <strong>bold</strong> idea &amp; a <a href="https://example.com">link</a>.</p>',
  textContent: "An idea",
  wordCount: 2,
  leadImage: null,
  publishedAt: null,
  savedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  state: "inbox",
  favorite: false,
  progress: 0,
  source: "api",
  captureStatus: "ok",
  captureError: null,
  tags: ["yes", "a: b", 'quote"', "line\nbreak", "[tag]"],
  summary: null,
};
const highlight: Highlight = {
  id: "highlight",
  articleId: article.id,
  userId: "user",
  quote: "First\r\nSecond",
  prefix: "",
  suffix: "",
  note: "My note",
  color: "yellow",
  createdAt: article.savedAt,
  updatedAt: article.savedAt,
};

describe("Markdown exports", () => {
  it("round-trips the JSON-compatible YAML scalar and list values", () => {
    const input = { ...article, title: 'Title\n---\nstate: archived\t\\\"\u0085\u2028\u2029' };
    const { markdown } = articleToMarkdown(input, []);
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("---");
    const end = lines.indexOf("---", 1);
    const metadata = Object.fromEntries(
      lines.slice(1, end).map((line) => {
        const separator = line.indexOf(": ");
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 2))];
      }),
    );
    expect(metadata).toEqual({
      title: input.title,
      url: input.url,
      author: input.author,
      site: input.siteName,
      saved: input.savedAt,
      published: null,
      tags: input.tags,
      state: input.state,
      later_id: input.id,
    });
    expect(markdown).not.toMatch(/[\u0085\u2028\u2029]/);
  });

  it("creates an Obsidian path, converts HTML, and exports matching highlights with notes", () => {
    const result = articleToMarkdown(article, [
      highlight,
      { ...highlight, articleId: "other", quote: "Excluded" },
    ]);
    expect(result.path).toBe("Later/cafe-ideas-more-abcdef.md");
    expect(result.markdown).toContain("## Heading");
    expect(result.markdown).toContain("**bold**");
    expect(result.markdown).toContain("[link](https://example.com)");
    expect(result.markdown).toContain("## Highlights\n\n> First\n> Second\n\nMy note");
    expect(result.markdown).not.toContain("Excluded");
  });

  it("handles empty content, nullable metadata, empty tags and punctuation-only titles", () => {
    const result = articleToMarkdown(
      { ...article, title: "../?!", contentHtml: "", author: null, siteName: null, tags: [] },
      [{ ...highlight, note: null }],
    );
    expect(result.path).toBe("Later/untitled-abcdef.md");
    expect(result.markdown).toContain("author: null\nsite: null");
    expect(result.markdown).toContain("tags: []");
    expect(result.markdown).not.toContain("null\n\n");
  });

  it("zips every Markdown file with UTF-8 contents and handles an empty export", () => {
    const items = [
      articleToMarkdown(article, []),
      articleToMarkdown({ ...article, id: "123456abcdef", title: "日本語" }, []),
    ];
    const files = unzipSync(markdownZip(items));
    expect(Object.keys(files).sort()).toEqual(items.map((item) => item.path).sort());
    for (const item of items) expect(strFromU8(files[item.path])).toBe(item.markdown);
    expect(Object.keys(unzipSync(markdownZip([])))).toEqual([]);
  });
});

it("exports a complete pretty JSON bundle without changing it", () => {
  const bundle: ExportBundle = {
    version: 1,
    exportedAt: article.savedAt,
    articles: [article],
    highlights: [highlight],
    feeds: [],
  };
  const original = structuredClone(bundle);
  const json = exportJson(bundle);
  expect(JSON.parse(json)).toEqual(original);
  expect(json).toContain('\n  "version": 1,');
  expect(bundle).toEqual(original);
});

it("exports buildEpub from the contracted module", () => {
  expect(buildEpub([], { title: "Empty" })).toBeInstanceOf(Uint8Array);
});
