import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

interface FeedItem {
  guid: string;
  url: string;
  title: string;
  contentHtml: string | null;
  publishedAt: string | null;
}

interface Feed {
  title: string;
  items: FeedItem[];
}

type Node = Record<string, unknown>;

function node(value: unknown): Node {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Node) : {};
}

function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof node(value)["#text"] === "string" ? (node(value)["#text"] as string) : "";
}

function resolve(value: unknown, base: string): string {
  const href = text(value).trim();
  if (!href) return "";
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function date(value: unknown): string | null {
  const source = text(value).trim();
  if (!source) return null;
  const timestamp = Date.parse(source);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function atomContent(value: unknown, orderedBody: unknown): string | null {
  if (value === undefined || value === null) return null;
  const content = node(value);
  if (content["@_type"] === "xhtml") {
    return new XMLBuilder({ ignoreAttributes: false, preserveOrder: true }).build(
      list(orderedBody),
    ) as string;
  }
  const body = text(value);
  return content["@_type"] === "html" ? body : escapeHtml(body);
}

export function parseFeed(xml: string, feedUrl: string): Feed {
  const source = xml.trim();
  if (source.startsWith("{")) {
    const feed = node(JSON.parse(source));
    return {
      title: text(feed.title),
      items: list(feed.items).map((value): FeedItem => {
        const item = node(value);
        const url = resolve(item.url ?? item.external_url, feedUrl);
        return {
          guid: text(item.id) || url,
          url,
          title: text(item.title),
          contentHtml:
            typeof item.content_html === "string"
              ? item.content_html
              : typeof item.content_text === "string"
                ? escapeHtml(item.content_text)
                : null,
          publishedAt: date(item.date_published),
        };
      }),
    };
  }

  if (XMLValidator.validate(source) !== true) throw new Error("Invalid feed XML");
  const parserOptions = {
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  };
  const parsed = node(new XMLParser(parserOptions).parse(source));
  if (parsed.rss !== undefined) {
    const channel = node(node(parsed.rss).channel);
    return {
      title: text(channel.title),
      items: list(channel.item).map((value): FeedItem => {
        const item = node(value);
        const url = resolve(item.link, feedUrl);
        return {
          guid: text(item.guid) || url,
          url,
          title: text(item.title),
          contentHtml:
            item.encoded !== undefined
              ? text(item.encoded)
              : item.description !== undefined
                ? text(item.description)
                : null,
          publishedAt: date(item.pubDate),
        };
      }),
    };
  }
  if (parsed.feed !== undefined) {
    const feed = node(parsed.feed);
    const orderedFeed = list(new XMLParser({ ...parserOptions, preserveOrder: true }).parse(source))
      .map(node)
      .find((element) => element.feed !== undefined);
    const orderedEntries = list(orderedFeed?.feed)
      .map(node)
      .filter((element) => element.entry !== undefined);
    return {
      title: text(feed.title),
      items: list(feed.entry).map((value, index): FeedItem => {
        const item = node(value);
        const contentTag = item.content != null ? "content" : "summary";
        const orderedContent = list(orderedEntries[index]?.entry)
          .map(node)
          .find((element) => element[contentTag] !== undefined);
        const link = list(item.link)
          .map(node)
          .find((link) => link["@_rel"] === undefined || link["@_rel"] === "alternate");
        const url = resolve(link?.["@_href"], feedUrl);
        return {
          guid: text(item.id) || url,
          url,
          title: text(item.title),
          contentHtml: atomContent(item.content ?? item.summary, orderedContent?.[contentTag]),
          publishedAt: date(item.published ?? item.updated),
        };
      }),
    };
  }
  throw new Error("Unsupported feed format");
}
