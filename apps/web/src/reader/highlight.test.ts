import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { applyHighlight, applyHighlights, removeHighlight, findQuote, contextFor } from "./highlight.ts";

function root(html: string) {
  const { document } = parseHTML(`<html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById("r")!;
}
const a = (o: Partial<Parameters<typeof applyHighlight>[1]> & { quote: string }) => ({
  id: "h1",
  prefix: "",
  suffix: "",
  color: "yellow" as const,
  ...o,
});

describe("highlight anchoring", () => {
  it("wraps a quote in a single text node", () => {
    const r = root("<p>The quick brown fox</p>");
    expect(applyHighlight(r, a({ quote: "quick brown" }))).toBe(true);
    const m = r.querySelector("mark")!;
    expect(m.textContent).toBe("quick brown");
    expect(m.getAttribute("data-hid")).toBe("h1");
    expect(r.textContent).toBe("The quick brown fox");
  });
  it("wraps a quote spanning inline elements", () => {
    const r = root("<p>Hello <b>big</b> world today</p>");
    expect(applyHighlight(r, a({ quote: "lo big wor" }))).toBe(true);
    const marks = r.querySelectorAll("mark");
    expect(marks.length).toBe(3);
    expect(
      Array.from(marks)
        .map((m) => m.textContent)
        .join(""),
    ).toBe("lo big wor");
    expect(r.textContent).toBe("Hello big world today");
  });
  it("uses prefix/suffix to disambiguate repeats", () => {
    const r = root("<p>cat sat here.</p><p>dog sat there.</p>");
    expect(applyHighlight(r, a({ quote: "sat", prefix: "dog ", suffix: " there." }))).toBe(true);
    expect(r.querySelectorAll("p")[1]!.querySelector("mark")).not.toBeNull();
    expect(r.querySelectorAll("p")[0]!.querySelector("mark")).toBeNull();
  });
  it("returns false when the quote is gone", () => {
    const r = root("<p>nothing</p>");
    expect(applyHighlight(r, a({ quote: "absent" }))).toBe(false);
    expect(r.querySelector("mark")).toBeNull();
  });
  it("applies multiple highlights and removes one", () => {
    const r = root("<p>alpha beta gamma delta</p>");
    const ok = applyHighlights(r, [
      a({ id: "x", quote: "beta" }),
      a({ id: "y", quote: "delta", color: "blue" }),
    ]);
    expect([...ok].sort()).toEqual(["x", "y"]);
    expect(r.querySelector('mark[data-hid="y"]')!.getAttribute("data-color")).toBe("blue");
    removeHighlight(r, "x");
    expect(r.querySelector('mark[data-hid="x"]')).toBeNull();
    expect(r.textContent).toBe("alpha beta gamma delta");
  });
  it("findQuote and contextFor", () => {
    const t = "0123456789".repeat(10);
    expect(findQuote(t, "345", "12", "67")).toBe(3);
    const c = contextFor(t, 40, 45);
    expect(c.prefix.length).toBe(32);
    expect(c.suffix).toBe(t.slice(45, 77));
    expect(findQuote(t, "", "", "")).toBe(-1);
  });
});

import { selectionAnchor } from "./highlight.ts";

describe("selectionAnchor element boundaries", () => {
  const mk = (html: string) => {
    const { document } = parseHTML(`<html><body><div id="r">${html}</div></body></html>`);
    return { document, r: document.getElementById("r")! };
  };
  const range = (sc: Node, so: number, ec: Node, eo: number) =>
    ({ startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo }) as unknown as Range;
  it("handles a range ending at element offset 0 (triple-click)", () => {
    const { r } = mk("<p>First para</p><p>Second</p>");
    const [p1, p2] = Array.from(r.querySelectorAll("p"));
    const a = selectionAnchor(r, range(p1!.firstChild!, 0, p2!, 0));
    expect(a!.quote).toBe("First para");
    expect(a!.suffix).toBe("Second");
  });
  it("handles element start and end containers", () => {
    const { r } = mk("<p>One <b>two</b> three</p>");
    const p = r.querySelector("p")!;
    const a = selectionAnchor(r, range(p, 0, p, p.childNodes.length));
    expect(a!.quote).toBe("One two three");
  });
  it("returns null for empty", () => {
    const { r } = mk("<p>x</p>");
    const p = r.querySelector("p")!;
    expect(selectionAnchor(r, range(p, 0, p, 0))).toBeNull();
  });
});
