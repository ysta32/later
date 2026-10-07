import { strToU8, zipSync, type Zippable } from "fflate";
import TurndownService from "turndown";
import type { Article, ExportBundle, Highlight } from "./types.ts";

export { buildEpub } from "./epub.ts";

export function articleToMarkdown(a: Article, hs: Highlight[]): { path: string; markdown: string } {
  const slug =
    a.title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  const metadata = {
    title: a.title,
    url: a.url,
    author: a.author,
    site: a.siteName,
    saved: a.savedAt,
    published: a.publishedAt,
    tags: a.tags,
    state: a.state,
    later_id: a.id,
  };
  const frontmatter = Object.entries(metadata)
    .map(
      ([key, value]) =>
        `${key}: ${JSON.stringify(value).replace(
          /[\u0085\u2028\u2029]/g,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )}`,
    )
    .join("\n");
  const body = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(a.contentHtml);
  const highlights = hs
    .filter((h) => h.articleId === a.id)
    .map((h) => {
      const quote = h.quote
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return h.note ? `${quote}\n\n${h.note}` : quote;
    });
  return {
    path: `Later/${slug}-${a.id.slice(0, 6)}.md`,
    markdown: `---\n${frontmatter}\n---\n\n${body}\n\n## Highlights\n\n${highlights.join("\n\n")}\n`,
  };
}

export function exportJson(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function markdownZip(items: { path: string; markdown: string }[]): Uint8Array {
  const files: Zippable = Object.create(null);
  for (const item of items) {
    files[item.path] = strToU8(item.markdown);
  }
  return zipSync(files);
}
