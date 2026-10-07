import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { DOMParser } from "linkedom";
import { XMLValidator } from "fast-xml-parser";
import { buildEpub } from "./epub.ts";
import type { Article } from "./types.ts";

const article: Article = {
  id: "abcdef123456",
  userId: "user",
  url: "https://example.com/article?a=1&b=2",
  title: 'Title < & " Ω 😀',
  author: "A & B <Writer>",
  siteName: "Example",
  excerpt: null,
  contentHtml:
    '<p>A &amp; B&nbsp;<br>Next <em>part</em></p><img src="https://example.com/image.jpg" alt="Photo &amp; caption">',
  textContent: "A & B",
  wordCount: 3,
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
  tags: [],
  summary: null,
};

function parseXml(source: string) {
  expect(XMLValidator.validate(source)).toBe(true);
  return new DOMParser().parseFromString(source, "text/xml") as unknown as Document;
}

function xmlAttribute(element: Element | undefined, name: string) {
  // Linkedom's XML parser leaves &amp; encoded in attributes; decode it once.
  return element?.getAttribute(name)?.replace(/&amp;/g, "&");
}

describe("EPUB3 export", () => {
  it("writes mimetype as the first ZIP entry, stored and without extra fields", () => {
    const bytes = buildEpub([article], { title: "Book" });
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(header.getUint32(0, true)).toBe(0x04034b50);
    expect(header.getUint16(8, true)).toBe(0);
    expect(header.getUint16(26, true)).toBe(8);
    expect(header.getUint16(28, true)).toBe(0);
    expect(strFromU8(bytes.subarray(30, 38))).toBe("mimetype");
    expect(strFromU8(bytes.subarray(38, 38 + 20))).toBe("application/epub+zip");
    expect(strFromU8(unzipSync(bytes).mimetype)).toBe("application/epub+zip");
  });

  it("links all chapters through the manifest, spine and navigation with EPUB3 metadata", () => {
    const articles = [article, { ...article, title: "Second", id: "second" }];
    const title = 'Book < & " title';
    const files = unzipSync(buildEpub(articles, { title }));
    const container = parseXml(strFromU8(files["META-INF/container.xml"]));
    expect(container.querySelector("rootfile")?.getAttribute("full-path")).toBe("OEBPS/content.opf");
    const opf = parseXml(strFromU8(files["OEBPS/content.opf"]));
    expect(opf.documentElement.getAttribute("version")).toBe("3.0");
    expect(opf.getElementsByTagName("dc:title")[0].textContent).toBe(title);
    expect(opf.getElementsByTagName("dc:language")[0].textContent).toBe("en");
    const identifier = opf.getElementsByTagName("dc:identifier")[0];
    expect(identifier.id).toBe(opf.documentElement.getAttribute("unique-identifier"));
    expect(identifier.textContent).toMatch(/^urn:uuid:/);
    expect(opf.querySelector('meta[property="dcterms:modified"]')?.textContent).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    const nav = parseXml(strFromU8(files["OEBPS/nav.xhtml"]));
    expect(nav.querySelector("nav")?.getAttribute("epub:type")).toBe("toc");
    expect(nav.querySelectorAll("li")).toHaveLength(2);
    expect(opf.querySelectorAll("itemref")).toHaveLength(2);
    articles.forEach((input, index) => {
      const id = `chapter-${index + 1}`;
      const filename = opf.querySelector(`item[id="${id}"]`)?.getAttribute("href");
      expect(filename).toBe(`${id}.xhtml`);
      expect(opf.querySelector(`itemref[idref="${id}"]`)).not.toBeNull();
      expect(nav.querySelector(`a[href="${filename}"]`)?.textContent).toBe(input.title);
      const chapter = parseXml(strFromU8(files[`OEBPS/${filename}`]));
      expect(chapter.documentElement.getAttribute("xmlns")).toBe("http://www.w3.org/1999/xhtml");
      expect(chapter.querySelector("h1")?.textContent).toBe(input.title);
      expect(chapter.querySelector("p")?.textContent).toBe(input.author);
      expect(xmlAttribute(chapter.querySelector("a") ?? undefined, "href")).toBe(input.url);
      expect(chapter.querySelectorAll("img")).toHaveLength(0);
      expect(chapter.documentElement.textContent).toContain("Photo & caption");
    });
  });

  it("normalizes malformed HTML, void tags, entities and invalid XML characters", () => {
    const contentHtml =
      '<p>Unclosed &copy; &nbsp; & text\u0001\ud800<em>bold<br>line<hr><p title="a &amp; &quot;b&quot; literal &amp;amp;">last 😀';
    const files = unzipSync(buildEpub([{ ...article, contentHtml }], { title: "Book" }));
    const source = strFromU8(files["OEBPS/chapter-1.xhtml"]);
    const chapter = parseXml(source);
    expect(source).not.toMatch(/[\u0001\ud800]/);
    expect(source).toContain("&amp; text");
    expect(chapter.documentElement.textContent).toContain("Unclosed ©");
    expect(chapter.documentElement.textContent).toContain("last 😀");
    expect(source).toContain('title="a &amp; &quot;b&quot; literal &amp;amp;"');
    expect(xmlAttribute(chapter.querySelector("p[title]") ?? undefined, "title")).toBe(
      'a & "b" literal &amp;',
    );
  });

  it("strips unsupported embeds and unsafe attributes while preserving readable content", () => {
    const contentHtml =
      '<script>alert(1)</script><style>bad css</style><iframe src="https://example.com">frame</iframe><svg><text>vector</text></svg><custom>Readable</custom><p onclick="bad()">Body</p><a href="javascript:alert(1)">Unsafe</a><a href="/relative?a=1&amp;b=2">Relative</a>';
    const files = unzipSync(buildEpub([{ ...article, contentHtml }], { title: "Book" }));
    const source = strFromU8(files["OEBPS/chapter-1.xhtml"]);
    const chapter = parseXml(source);
    expect(source).not.toMatch(/script|style|iframe|svg|onclick|javascript|bad css|vector/);
    expect(chapter.documentElement.textContent).toContain("Readable");
    const links = Array.from(chapter.querySelectorAll("a"));
    expect(links.find((a) => a.textContent === "Unsafe")?.hasAttribute("href")).toBe(false);
    expect(
      xmlAttribute(
        links.find((a) => a.textContent === "Relative"),
        "href",
      ),
    ).toBe("https://example.com/relative?a=1&b=2");
  });

  it("handles empty selections and articles without source URLs or authors", () => {
    for (const articles of [[], [{ ...article, url: "", author: null, contentHtml: "" }]]) {
      const files = unzipSync(buildEpub(articles, { title: "Empty" }));
      for (const [path, bytes] of Object.entries(files)) {
        if (path !== "mimetype") parseXml(strFromU8(bytes));
      }
      const opf = parseXml(strFromU8(files["OEBPS/content.opf"]));
      expect(opf.querySelectorAll("itemref")).toHaveLength(1);
    }
  });
});
