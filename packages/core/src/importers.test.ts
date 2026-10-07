import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectFormat, parseImport } from "./importers.ts";
import type { ImportFormat } from "./types.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url), "utf8");
const examples: [ImportFormat, string, number][] = [
  ["pocket", "ril_export.html", 2],
  ["pocket", "pocket.csv", 2],
  ["omnivore", "metadata_001.json", 2],
  ["instapaper", "instapaper.csv", 3],
  ["readwise", "reader.csv", 4],
  ["readwise", "readwise-highlights.csv", 1],
  ["bookmarks", "bookmarks.html", 5],
];

describe("import detection", () => {
  it.each(examples)("detects %s from %s", (format, filename) => {
    expect(detectFormat(filename, fixture(filename))).toBe(format);
    expect(detectFormat("renamed.txt", fixture(filename))).toBe(format);
  });
  it("handles BOM and CRLF CSV", () => {
    const data = `\uFEFF${fixture("pocket.csv").replaceAll("\n", "\r\n")}`;
    expect(detectFormat("export.csv", data)).toBe("pocket");
    expect(parseImport("pocket", data)).toHaveLength(2);
  });
  it("returns null for unknown or invalid data", () => {
    for (const data of [
      "",
      "hello",
      "{}",
      "[",
      "[]",
      '[{"url":"https://example.com"}]',
      "<html><body>Hello</body></html>",
      "a,b\n1,2",
    ]) {
      expect(detectFormat("unknown.txt", data)).toBeNull();
    }
    expect(detectFormat("metadata_001.json", "[]")).toBe("omnivore");
  });
});

describe("import parsing", () => {
  it.each(examples)("normalizes %s from %s", (format, filename, count) => {
    const result = parseImport(format, fixture(filename));
    expect(result).toHaveLength(count);
    expect(new Set(result.map((entry) => entry.url)).size).toBe(count);
    for (const entry of result) {
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(entry.savedAt === null || new Date(entry.savedAt).toISOString() === entry.savedAt).toBe(true);
      expect(["inbox", "archived"]).toContain(entry.state);
      expect(typeof entry.favorite).toBe("boolean");
      expect(Array.isArray(entry.highlights)).toBe(true);
    }
  });
  it.each(["ril_export.html", "pocket.csv"])("preserves Pocket metadata in %s", (filename) => {
    const [unread, archived] = parseImport("pocket", fixture(filename));
    expect(unread).toMatchObject({
      tags: ["science", "space"],
      savedAt: "2024-01-01T00:00:00.000Z",
      state: "inbox",
      favorite: false,
    });
    expect(archived).toMatchObject({
      tags: ["history"],
      savedAt: "2024-01-02T00:00:00.000Z",
      state: "archived",
    });
    expect(unread.title).toBe(filename.endsWith("html") ? "Space & time" : "Space, time");
  });
  it("preserves Omnivore labels, archive state and annotations", () => {
    const [entry, archived] = parseImport("omnivore", fixture("metadata_001.json"));
    expect(entry).toMatchObject({
      title: "Space",
      tags: ["science", "space"],
      savedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(entry.highlights).toEqual([
      { quote: "First thought", note: "My note", createdAt: null },
      { quote: "Second thought", note: null, createdAt: null },
    ]);
    expect(archived.state).toBe("archived");
  });
  it("maps Instapaper folders, selections and favorites", () => {
    const [entry, archived, starred] = parseImport("instapaper", fixture("instapaper.csv"));
    expect(entry).toMatchObject({
      title: 'A "quoted" title',
      tags: ["Research"],
      savedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(entry.highlights).toEqual([
      { quote: "A selected passage\nwith a second line", note: null, createdAt: null },
    ]);
    expect(archived).toMatchObject({ state: "archived", favorite: false, tags: [] });
    expect(starred).toMatchObject({ state: "inbox", favorite: true, tags: [], savedAt: null });
  });
  it("maps Reader locations and both tag list syntaxes", () => {
    const [entry, archived, later, feed] = parseImport("readwise", fixture("reader.csv"));
    expect(entry.tags).toEqual(["science", "space, time"]);
    expect(archived).toMatchObject({ state: "archived", tags: ["history", "long reads, essays"] });
    expect(later).toMatchObject({ state: "inbox", savedAt: null, tags: [] });
    expect(feed.state).toBe("inbox");
  });
  it.each(["Unread", " unread ", "UNREAD"])("treats Instapaper %s as the inbox", (folder) => {
    expect(parseImport("instapaper", `URL,Title,Folder\nhttps://example.com,Story,${folder}`)).toMatchObject([
      { url: "https://example.com", state: "inbox", favorite: false, tags: [] },
    ]);
  });
  it.each(["pocket", "instapaper", "readwise"] as const)("skips malformed %s CSV rows", (format) => {
    const result = parseImport(
      format,
      "url,title\nhttps://example.com/first,First\nhttps://example.com/few\nhttps://example.com/many,Many,Extra\nhttps://example.com/last,Last",
    );
    expect(result.map(({ url, title }) => ({ url, title }))).toEqual([
      { url: "https://example.com/first", title: "First" },
      { url: "https://example.com/last", title: "Last" },
    ]);
    expect(() => parseImport(format, "url,title\nhttps://example.com/few")).toThrow(/Invalid import CSV/);
  });
  it.each(["pocket", "instapaper", "readwise"] as const)("accepts one-column %s CSV", (format) => {
    expect(
      parseImport(format, "url\nhttps://example.com/one\nhttps://example.com/two").map(({ url }) => url),
    ).toEqual(["https://example.com/one", "https://example.com/two"]);
  });
  it("preserves valid CSV rows before an unterminated quote", () => {
    expect(
      parseImport(
        "pocket",
        'url,title\nhttps://example.com/good,Good\nhttps://example.com/bad,"unterminated',
      ),
    ).toMatchObject([{ url: "https://example.com/good", title: "Good" }]);
  });
  it("groups Readwise highlights by URL and retains notes, tags and dates", () => {
    const [entry] = parseImport("readwise", fixture("readwise-highlights.csv"));
    expect(entry).toMatchObject({ title: "Essay", tags: ["science", "idea", "space"], savedAt: null });
    expect(entry.highlights).toEqual([
      { quote: "First thought", note: "My note", createdAt: "2024-01-01T00:00:00.000Z" },
      { quote: "Second thought", note: null, createdAt: "2024-01-02T00:00:00.000Z" },
    ]);
    expect(
      parseImport(
        "readwise",
        "Highlight,Book Title,Book Author,Amazon Book ID,Note,Color,Tags,Location Type,Location,Highlighted at,Document tags\nPassage,Book,Author,,,,,page,1,2024-01-01,\n",
      ),
    ).toEqual([]);
  });
  it("tracks nested bookmark folders without leaking tags into siblings", () => {
    const [entry, nested, sibling, other, root] = parseImport("bookmarks", fixture("bookmarks.html"));
    expect(entry).toMatchObject({
      title: "Space & time",
      savedAt: "2024-01-01T00:00:00.000Z",
      tags: ["science", "space", "Other", "extra"],
    });
    expect(nested).toMatchObject({ tags: ["Nested"], savedAt: null });
    expect(sibling.tags).toEqual([]);
    expect(other.tags).toEqual(["Other"]);
    expect(root.tags).toEqual([]);
  });
  it.each([
    "Bookmarks bar",
    "Bookmarks Bar",
    "Bookmarks Toolbar",
    "Bookmarks Menu",
    "Other bookmarks",
    "Other Bookmarks",
    "Mobile bookmarks",
    "Favorites",
    "Favorites Bar",
  ])("omits the %s root folder but preserves nested names and explicit tags", (folder) => {
    const entries = parseImport(
      "bookmarks",
      `<DL>
      <DT><H3>${folder}</H3><DL>
        <DT><A HREF="https://example.com/direct">Direct</A></DT>
        <DT><H3>${folder}</H3><DL>
          <DT><A HREF="https://example.com/nested">Nested</A></DT>
        </DL></DT>
        <DT><A HREF="https://example.com/tagged" TAGS="${folder}">Tagged</A></DT>
      </DL></DT>
      <DT><H3>Research</H3><DL><DT><A HREF="https://example.com/research">Research</A></DT></DL></DT>
    </DL>`,
    );
    expect(entries.map(({ tags }) => tags)).toEqual([[], [folder], [folder], ["Research"]]);
  });
  it("skips invalid URLs and malformed records, normalizes blank metadata", () => {
    const result = parseImport(
      "omnivore",
      JSON.stringify([
        null,
        3,
        {},
        { url: "/relative" },
        { url: "ftp://example.com" },
        { url: "https://" },
        {
          url: " http://example.com/ ",
          title: " ",
          labels: ["a", "a", null],
          savedAt: "invalid",
          highlights: [null, {}, { quote: " " }],
        },
      ]),
    );
    expect(result).toEqual([
      {
        url: "http://example.com/",
        title: null,
        tags: ["a"],
        savedAt: null,
        state: "inbox",
        favorite: false,
        highlights: [],
      },
    ]);
  });
  it("deduplicates repeated highlight rows", () => {
    const data = fixture("readwise-highlights.csv");
    const duplicate = data.split("\n")[1];
    expect(parseImport("readwise", `${data}${duplicate}\n`)[0].highlights).toHaveLength(2);
  });
  it("rejects malformed exports with no parseable records", () => {
    expect(() => parseImport("omnivore", "{")).toThrow();
    expect(() => parseImport("omnivore", "{}")).toThrow(/array/);
    expect(() => parseImport("pocket", 'title,url,time_added,tags,status\n"unterminated')).toThrow(
      /Invalid import CSV/,
    );
  });
  it("accepts empty exports", () => {
    expect(parseImport("omnivore", "[]")).toEqual([]);
    expect(parseImport("bookmarks", "")).toEqual([]);
    expect(parseImport("pocket", "title,url,time_added,tags,status\n")).toEqual([]);
  });
});
