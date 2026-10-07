import { describe, expect, it } from "vitest";
import { parseRoute, readingTime } from "./app.tsx";
import { bookmarklet, detectImportFormat } from "./pages/Settings.tsx";

describe("hash routing", () => {
  it.each(["archive", "favorites", "search", "highlights", "ask", "settings"])("routes %s", (page) => {
    expect(parseRoute(`#/${page}`)).toEqual({ page });
  });
  it("decodes tags and article ids without interpreting encoded slashes", () => {
    expect(parseRoute("#/tag/slow%20living%2Fbooks")).toEqual({
      page: "tag",
      value: "slow living/books",
    });
    expect(parseRoute("#/read/abc-123")).toEqual({
      page: "read",
      value: "abc-123",
    });
    expect(parseRoute("#/saved/123")).toEqual({ page: "saved", value: "123" });
  });
  it.each(["", "#/", "#/unknown", "#/read/", "#/tag/%E0%A4%A", "#/read/a/b"])(
    "safely defaults %s",
    (hash) => {
      expect(parseRoute(hash)).toEqual({ page: "inbox" });
    },
  );
});
describe("reading time", () => {
  it.each([
    [0, 1],
    [230, 1],
    [231, 2],
    [920, 4],
    [-20, 1],
    [NaN, 1],
    [Infinity, 1],
  ])("%s words takes %s minutes", (words, minutes) => {
    expect(readingTime(words)).toBe(minutes);
  });
});
describe("capture settings", () => {
  it("loads the same-origin bookmarklet script with an encoded token", () => {
    const code = bookmarklet("https://later.example", "a&b'c");
    let source = "";
    const document = {
      createElement: () => ({ src: "" }),
      body: {
        appendChild: (script: { src: string }) => {
          source = script.src;
        },
      },
    };
    new Function("document", code.slice("javascript:".length))(document);
    expect(new URL(source).origin).toBe("https://later.example");
    expect(new URL(source).pathname).toBe("/bookmarklet.js");
    expect(new URL(source).searchParams.get("token")).toBe("a&b'c");
  });
  it("detects known exports and leaves unknown formats for explicit selection", () => {
    expect(detectImportFormat("ril_export.html", "<html>")).toBe("pocket");
    expect(detectImportFormat("data.html", "<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe("bookmarks");
    expect(detectImportFormat("instapaper.csv", "URL,Title")).toBe("instapaper");
    expect(detectImportFormat("unknown.json", "{}")).toBeNull();
  });
});
