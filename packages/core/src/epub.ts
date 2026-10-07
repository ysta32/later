import { strToU8, zipSync, type Zippable } from "fflate";
import { DOMParser } from "linkedom";
import type { Article } from "./types.ts";

const elements = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
]);
const discarded = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "head",
  "link",
  "meta",
  "svg",
  "math",
  "audio",
  "video",
  "source",
  "input",
  "button",
  "select",
  "textarea",
]);

function xml(text: string): string {
  return text
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeLink(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl || undefined);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function serialize(node: Node, baseUrl: string): string {
  if (node.nodeType === 3) return xml(node.textContent ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.localName.toLowerCase();
  if (discarded.has(tag)) return "";
  if (tag === "img") return xml(element.getAttribute("alt") ?? "");
  const children = Array.from(node.childNodes, (child) => serialize(child, baseUrl)).join("");
  if (!elements.has(tag)) return children;
  let attributes = "";
  for (const name of ["title", "lang", "dir", "colspan", "rowspan", "start", "reversed", "value"]) {
    const value = element.getAttribute(name);
    if (value !== null) attributes += ` ${name}="${xml(value)}"`;
  }
  if (tag === "a") {
    const href = element.getAttribute("href");
    const link = href === null ? null : safeLink(href, baseUrl);
    if (link !== null) attributes += ` href="${xml(link)}"`;
  }
  return ["br", "hr", "col"].includes(tag)
    ? `<${tag}${attributes} />`
    : `<${tag}${attributes}>${children}</${tag}>`;
}

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><title>${xml(title)}</title></head><body>${body}</body></html>`;
}

export function buildEpub(articles: Article[], opts: { title: string }): Uint8Array {
  const files: Zippable = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles></container>`),
  };
  const manifest: string[] = [];
  const spine: string[] = [];
  const navigation: string[] = [];
  articles.forEach((article, index) => {
    const id = `chapter-${index + 1}`;
    const filename = `${id}.xhtml`;
    const document = new DOMParser().parseFromString(
      "<html><body></body></html>",
      "text/html",
    ) as unknown as Document;
    const content = document.createElement("div");
    content.innerHTML = article.contentHtml;
    const body = Array.from(content.childNodes, (node) => serialize(node, article.url)).join("");
    const source = safeLink(article.url, "");
    files[`OEBPS/${filename}`] = strToU8(
      xhtml(
        article.title,
        `<h1>${xml(article.title)}</h1>` +
          (article.author ? `<p>${xml(article.author)}</p>` : "") +
          (source ? `<p><a href="${xml(source)}">${xml(article.url)}</a></p>` : "") +
          body,
      ),
    );
    manifest.push(`<item id="${id}" href="${filename}" media-type="application/xhtml+xml" />`);
    spine.push(`<itemref idref="${id}" />`);
    navigation.push(`<li><a href="${filename}">${xml(article.title)}</a></li>`);
  });
  // EPUB requires a nonempty spine, including for an empty selection.
  if (articles.length === 0) spine.push('<itemref idref="nav" />');
  files["OEBPS/nav.xhtml"] = strToU8(
    xhtml(
      opts.title,
      `<nav epub:type="toc" id="toc"><h1>${xml(opts.title)}</h1><ol>${navigation.length ? navigation.join("") : '<li><a href="nav.xhtml">Contents</a></li>'}</ol></nav>`,
    ),
  );
  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${xml(opts.title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`);
  return zipSync(files);
}
