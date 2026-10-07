import { parseHTML } from "linkedom";
import { countWords, htmlToText, sanitizeHtml } from "./sanitize.ts";
import type { Extracted } from "./types.ts";

interface InboundEmail {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
}

interface ParsedInbound {
  inboundToken: string | null;
  url: string | null;
  extracted: Extracted | null;
}

function addresses(value: string): string[] {
  return value.replace(/"(?:[^"\\]|\\.)*"/g, "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) ?? [];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInbound(input: InboundEmail): ParsedInbound {
  const recipients = addresses(input.to);
  const recipient = recipients.find((address) => address.startsWith("save+")) ?? recipients[0];
  const local = recipient?.split("@")[0] ?? "";
  const inboundToken = (local.startsWith("save+") ? local.slice(5) : local) || null;
  const sender = addresses(input.from)[0];
  const siteName = sender?.split("@")[1]?.toLowerCase() ?? null;
  const displayName = input.from.includes("<")
    ? input.from
        .slice(0, input.from.indexOf("<"))
        .trim()
        .replace(/^"(.*)"$/, "$1")
    : "";
  const source =
    input.html ||
    (input.text ?? "")
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
      .join("");
  const { document } = parseHTML(`<html><body>${source}</body></html>`);
  for (const image of document.querySelectorAll("img")) {
    const style = image.getAttribute("style") ?? "";
    const width = image.getAttribute("width") ?? style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1];
    const height = image.getAttribute("height") ?? style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1];
    if (/^\s*1(?:px)?\s*$/i.test(width ?? "") && /^\s*1(?:px)?\s*$/i.test(height ?? "")) image.remove();
  }
  const contentHtml = sanitizeHtml(document.body.innerHTML, "");
  const textContent = htmlToText(contentHtml);
  const bodyText = input.text?.trim() || textContent;
  const urls = new Set<string>();
  const otherText = bodyText.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const candidate = match.replace(/[.,;!?)\]]+$/, "");
    const url = httpUrl(candidate);
    if (url) urls.add(url);
    return url ? "" : match;
  });
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = httpUrl(anchor.getAttribute("href") ?? "");
    if (url) urls.add(url);
  }
  if (urls.size === 1 && otherText.trim().length < 300) {
    return { inboundToken, url: [...urls][0], extracted: null };
  }
  return {
    inboundToken,
    url: null,
    extracted: {
      url: "",
      title: input.subject,
      author: displayName || null,
      siteName,
      excerpt: textContent.slice(0, 280) || null,
      contentHtml,
      textContent,
      wordCount: countWords(textContent),
      leadImage: null,
      publishedAt: null,
    },
  };
}
