import { describe, it, expect } from "vitest";
import { chunkText } from "./tts.ts";

describe("chunkText", () => {
  it("splits paragraphs and drops blanks", () => {
    expect(chunkText("One.\n\n\nTwo  words.\n   \nThree")).toEqual(["One.", "Two words.", "Three"]);
  });
  it("splits long paragraphs at sentence boundaries", () => {
    const text = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota.";
    const out = chunkText(text, 25);
    expect(out.every((c) => c.length <= 25)).toBe(true);
    expect(out.join(" ")).toBe(text);
  });
  it("splits unbroken text on words", () => {
    const out = chunkText("a ".repeat(50).trim(), 10);
    expect(out.every((c) => c.length <= 10)).toBe(true);
    expect(out.join(" ").split(" ").length).toBe(50);
  });
  it("empty input", () => {
    expect(chunkText("  \n ")).toEqual([]);
  });
});
