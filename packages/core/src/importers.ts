import Papa from "papaparse";
import { parseHTML } from "linkedom";
import type { ImportFormat, ImportItem } from "./types.ts";

type Row = Record<string, string>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function date(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(value);
  const timestamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(String(value));
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function tags(value: unknown, delimiter = ","): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map(text).filter((tag): tag is string => tag !== null))];
  }
  const source = text(value);
  if (!source) return [];
  if (source.startsWith("[") && source.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (Array.isArray(parsed)) return tags(parsed);
    } catch {
      // Some Reader exports use Python-style single-quoted lists.
      const entries = source.slice(1, -1).match(/\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|[^,]+)/g);
      return tags(
        entries?.map((entry) =>
          entry
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2")
            .replace(/\\(['"\\])/g, "$1"),
        ) ?? [],
      );
    }
  }
  return tags(source.split(delimiter));
}

function item(url: unknown, title: unknown): ImportItem | null {
  const address = text(url);
  if (!address) return null;
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    url: address,
    title: text(title),
    tags: [],
    savedAt: null,
    state: "inbox",
    favorite: false,
    highlights: [],
  };
}

function csv(data: string): Row[] {
  const result = Papa.parse<Row>(data, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) =>
      header
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase(),
  });
  if (result.errors.length) {
    throw new Error(`Invalid import CSV: ${result.errors[0].message}`);
  }
  return result.data;
}

function parseCsv(format: ImportFormat, data: string): ImportItem[] {
  const items: ImportItem[] = [];
  for (const row of csv(data)) {
    const entry = item(row.url, row.title ?? row["book title"]);
    if (!entry) continue;
    if (format === "pocket") {
      entry.tags = tags(row.tags, "|");
      entry.savedAt = date(row.time_added);
      entry.state = row.status?.toLowerCase() === "archive" ? "archived" : "inbox";
    } else if (format === "instapaper") {
      const folder = text(row.folder);
      entry.state = folder?.toLowerCase() === "archive" ? "archived" : "inbox";
      entry.favorite = folder?.toLowerCase() === "starred";
      entry.tags = folder && !["archive", "starred"].includes(folder.toLowerCase()) ? [folder] : [];
      entry.savedAt = date(row.timestamp);
      const quote = text(row.selection);
      if (quote) entry.highlights.push({ quote, note: null, createdAt: null });
    } else {
      entry.tags = tags([...tags(row["document tags"]), ...tags(row.tags)]);
      entry.savedAt = date(row["saved date"]);
      entry.state = row.location?.toLowerCase() === "archive" ? "archived" : "inbox";
      const quote = text(row.highlight);
      if (quote) {
        entry.highlights.push({
          quote,
          note: text(row.note),
          createdAt: date(row["highlighted at"]),
        });
      }
    }
    items.push(entry);
  }
  return items;
}

function parseOmnivore(data: string): ImportItem[] {
  const records: unknown = JSON.parse(data);
  if (!Array.isArray(records)) throw new Error("Invalid Omnivore import: expected a JSON array");
  const items: ImportItem[] = [];
  for (const value of records as unknown[]) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const entry = item(record.url, record.title);
    if (!entry) continue;
    entry.tags = tags(
      Array.isArray(record.labels)
        ? record.labels.map((label: unknown) =>
            label && typeof label === "object" && "name" in label ? label.name : label,
          )
        : [],
    );
    entry.savedAt = date(record.savedAt);
    entry.state = record.state === "ARCHIVED" ? "archived" : "inbox";
    if (Array.isArray(record.highlights)) {
      for (const value of record.highlights as unknown[]) {
        if (!value || typeof value !== "object") continue;
        const highlight = value as Record<string, unknown>;
        const quote = text(highlight.quote);
        if (quote) entry.highlights.push({ quote, note: text(highlight.annotation), createdAt: null });
      }
    }
    items.push(entry);
  }
  return items;
}

function parsePocketHtml(data: string): ImportItem[] {
  const { document } = parseHTML(data);
  const items: ImportItem[] = [];
  let archived = false;
  for (const node of document.querySelectorAll("h1, h2, a")) {
    if (node.localName !== "a") {
      archived = /archive/i.test(node.textContent ?? "");
      continue;
    }
    const entry = item(node.getAttribute("href"), node.textContent);
    if (!entry) continue;
    entry.savedAt = date(node.getAttribute("time_added"));
    entry.tags = tags(node.getAttribute("tags"));
    entry.state = archived ? "archived" : "inbox";
    items.push(entry);
  }
  return items;
}

function parseBookmarks(data: string): ImportItem[] {
  const { document } = parseHTML(data);
  const items: ImportItem[] = [];
  let pendingFolder: string | null = null;
  function visit(node: Element, folders: string[]): void {
    if (node.localName === "h3") pendingFolder = text(node.textContent);
    if (node.localName === "dl") {
      folders = pendingFolder ? [...folders, pendingFolder] : folders;
      pendingFolder = null;
    }
    if (node.localName === "a") {
      // Netscape exports commonly use uppercase attribute names.
      const attr = (name: string): string | null =>
        Array.from(node.attributes).find((attribute) => attribute.name.toLowerCase() === name)?.value ?? null;
      const entry = item(attr("href"), node.textContent);
      if (entry) {
        entry.tags = tags([...folders, ...tags(attr("tags"))]);
        entry.savedAt = date(attr("add_date"));
        items.push(entry);
      }
    }
    for (const child of node.children) visit(child, folders);
  }
  for (const child of document.children) visit(child, []);
  return items;
}

/** Parse one export file. Duplicate URLs retain the first record and merge tags/highlights. */
export function parseImport(format: ImportFormat, data: string): ImportItem[] {
  let parsed: ImportItem[];
  switch (format) {
    case "omnivore":
      parsed = parseOmnivore(data);
      break;
    case "bookmarks":
      parsed = parseBookmarks(data);
      break;
    case "pocket":
      parsed = /^\s*</.test(data) ? parsePocketHtml(data) : parseCsv(format, data);
      break;
    case "instapaper":
    case "readwise":
      parsed = parseCsv(format, data);
      break;
    default:
      throw new Error(`Unsupported import format: ${String(format)}`);
  }
  const unique = new Map<string, ImportItem>();
  for (const entry of parsed) {
    const existing = unique.get(entry.url);
    if (!existing) unique.set(entry.url, entry);
    else {
      existing.tags = tags([...existing.tags, ...entry.tags]);
      for (const highlight of entry.highlights) {
        if (
          !existing.highlights.some(
            (other) =>
              other.quote === highlight.quote &&
              other.note === highlight.note &&
              other.createdAt === highlight.createdAt,
          )
        ) {
          existing.highlights.push(highlight);
        }
      }
    }
  }
  return [...unique.values()];
}

export function detectFormat(filename: string, data: string): ImportFormat | null {
  const source = data.trimStart();
  if (source.startsWith("[")) {
    try {
      const records: unknown = JSON.parse(source);
      if (
        Array.isArray(records) &&
        records.some(
          (record: unknown) =>
            record !== null &&
            typeof record === "object" &&
            "url" in record &&
            ("savedAt" in record || "slug" in record || "labels" in record),
        )
      )
        return "omnivore";
      if (Array.isArray(records) && records.length === 0 && /(?:omnivore|metadata_).*\.json$/i.test(filename))
        return "omnivore";
    } catch {
      return null;
    }
    return null;
  }
  if (source.startsWith("<")) {
    if (/\btime_added\s*=/i.test(source) || /ril_export\.html$/i.test(filename)) return "pocket";
    if (/NETSCAPE-Bookmark-file-1|\bADD_DATE\s*=|<h3\b/i.test(source)) return "bookmarks";
    if (/<h1\b[^>]*>\s*(Unread|Read Archive)\s*<\/h1>/i.test(source)) return "pocket";
    return null;
  }
  const header = Papa.parse<string[]>(source, { preview: 1, skipEmptyLines: "greedy" }).data[0] ?? [];
  const fields = new Set(header.map((field) => field.trim().toLowerCase()));
  const has = (...names: string[]): boolean => names.every((name) => fields.has(name));
  if (has("url", "time_added", "tags")) return "pocket";
  if (has("url", "title", "selection", "folder", "timestamp")) return "instapaper";
  if (has("url", "title", "document tags", "saved date") || has("highlight", "book title", "highlighted at"))
    return "readwise";
  return null;
}
