import sanitize from "sanitize-html";
import { parseHTML } from "linkedom";

/** Hosts whose iframes (video embeds) survive sanitization. */
const EMBED_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
];

const ALLOWED_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
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
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "iframe",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strike",
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
  "video",
  "audio",
  "wbr",
  "main",
  "header",
  "footer",
];

const URL_ATTRS: Record<string, string[]> = {
  a: ["href"],
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  iframe: ["src"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite"],
  ins: ["cite"],
};

/** Resolve a possibly-relative URL against base. Returns the raw value if it cannot be parsed. */
function absolutize(value: string, base: URL | null): string {
  const v = value.trim();
  if (!v || v.startsWith("#")) return v;
  try {
    return base ? new URL(v, base).href : new URL(v).href;
  } catch {
    return v;
  }
}

function absolutizeSrcset(srcset: string, base: URL | null): string {
  return srcset
    .split(/,\s+(?=\S)/)
    .map((part) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      if (!u) return "";
      return [absolutize(u, base), ...desc].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

/** True for obvious lazy-load placeholders (data: URIs, 1x1 gifs, "blank"/"placeholder" images). */
function isPlaceholderSrc(src: string | undefined): boolean {
  if (!src || !src.trim()) return true;
  const s = src.trim().toLowerCase();
  return (
    s.startsWith("data:") ||
    /(?:^|[/_.-])(?:blank|placeholder|spacer|pixel|lazy)[^/]*\.(?:gif|png|svg|jpe?g|webp)/.test(s)
  );
}

const LAZY_SRC_ATTRS = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-lazy",
  "data-url",
  "data-hi-res-src",
];
const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

function fixLazyAttribs(attribs: Record<string, string>): Record<string, string> {
  const out = { ...attribs };
  if (isPlaceholderSrc(out.src)) {
    for (const a of LAZY_SRC_ATTRS) {
      if (out[a] && out[a].trim()) {
        out.src = out[a];
        break;
      }
    }
  }
  if (!out.srcset || isPlaceholderSrc(out.srcset)) {
    for (const a of LAZY_SRCSET_ATTRS) {
      if (out[a] && out[a].trim()) {
        out.srcset = out[a];
        break;
      }
    }
  }
  // If src is still a placeholder but a real srcset exists, use its first candidate.
  if (isPlaceholderSrc(out.src) && out.srcset && !isPlaceholderSrc(out.srcset)) {
    const first = out.srcset.trim().split(/\s+/)[0];
    if (first) out.src = first.replace(/,$/, "");
  }
  return out;
}

/**
 * Sanitize article HTML for display: removes scripts/styles/forms/event handlers/javascript: URLs,
 * keeps only YouTube/Vimeo iframes, fixes lazy-loaded images, and absolutizes URLs against baseUrl.
 */
export function sanitizeHtml(html: string, baseUrl: string): string {
  let base: URL | null = null;
  try {
    base = baseUrl ? new URL(baseUrl) : null;
  } catch {
    base = null;
  }
  const transform = (
    tagName: string,
    attribs: Record<string, string>,
  ): { tagName: string; attribs: Record<string, string> } => {
    let a = attribs;
    if (tagName === "img" || tagName === "source") a = fixLazyAttribs(a);
    else a = { ...a };
    for (const attr of URL_ATTRS[tagName] ?? []) {
      if (a[attr] !== undefined) a[attr] = absolutize(a[attr], base);
    }
    if (a.srcset !== undefined) a.srcset = absolutizeSrcset(a.srcset, base);
    return { tagName, attribs: a };
  };
  const transformTags: Record<string, typeof transform> = {};
  for (const t of ["a", "img", "source", "video", "audio", "iframe", "blockquote", "q", "del", "ins"]) {
    transformTags[t] = transform;
  }
  return sanitize(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "name"],
      img: ["src", "srcset", "sizes", "alt", "title", "width", "height"],
      source: ["src", "srcset", "sizes", "type", "media"],
      video: ["src", "poster", "controls", "width", "height", "loop", "muted", "playsinline"],
      audio: ["src", "controls"],
      iframe: ["src", "width", "height", "allowfullscreen", "frameborder", "allow", "title"],
      td: ["colspan", "rowspan", "align"],
      th: ["colspan", "rowspan", "scope", "align"],
      col: ["span"],
      colgroup: ["span"],
      ol: ["start", "type", "reversed"],
      li: ["value"],
      time: ["datetime"],
      blockquote: ["cite"],
      q: ["cite"],
      del: ["cite"],
      ins: ["cite"],
      abbr: ["title"],
      details: ["open"],
      code: ["class"],
      pre: ["class"],
    },
    allowedClasses: {
      code: [/^language-[\w-]+$/, /^lang-[\w-]+$/],
      pre: [/^language-[\w-]+$/, /^lang-[\w-]+$/],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "poster", "srcset"],
    allowProtocolRelative: false,
    allowedIframeHostnames: EMBED_HOSTS,
    allowIframeRelativeUrls: false,
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "noscript",
      "template",
      "select",
      "button",
      "svg",
      "math",
      "head",
      "title",
    ],
    disallowedTagsMode: "discard",
    transformTags,
    exclusiveFilter: (frame) =>
      // drop images that still have no usable src, and iframes stripped of their src
      (frame.tag === "img" || frame.tag === "iframe") && !frame.attribs.src,
  });
}

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SVG", "IFRAME"]);

/** Convert HTML to plain text, keeping paragraph/line breaks between block elements. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const { document } = parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  ) as unknown as { document: Document };
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        parts.push((child.nodeValue ?? "").replace(/\s+/g, " "));
      } else if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toUpperCase();
        if (SKIP_TAGS.has(tag)) continue;
        const block = BLOCK_TAGS.has(tag);
        if (block) parts.push("\n");
        if (tag === "PRE") parts.push(child.textContent ?? "");
        else walk(child);
        if (block) parts.push("\n");
      }
    }
  };
  if (document.body) walk(document.body);
  return parts
    .join("")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n[ \t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;

/** Count words; each CJK character counts as one word. */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, " ");
  const words = rest.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length ?? 0;
  return cjk + words;
}
