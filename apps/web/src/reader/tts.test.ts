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

import { parseHTML } from "linkedom";
import { speakableBlocks, createTts } from "./tts.ts";

describe("speakableBlocks", () => {
  const blocks = (html: string) => {
    const { document } = parseHTML(`<html><body><div id="r">${html}</div></body></html>`);
    return speakableBlocks(document.getElementById("r")!).map((b) => b.text);
  };
  it("does not duplicate nested blocks", () => {
    expect(blocks("<blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote><p>After</p>")).toEqual([
      "Quoted one.",
      "Quoted two.",
      "After",
    ]);
    expect(blocks("<ul><li>Item <ul><li>Sub</li></ul></li><li><p>Para</p></li></ul>")).toEqual([
      "Item",
      "Sub",
      "Para",
    ]);
  });
  it("skips empty blocks", () => {
    expect(blocks("<p> </p><p>x</p>")).toEqual(["x"]);
  });
});

describe("createTts", () => {
  class Utt {
    rate = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  }
  const setup = () => {
    (globalThis as any).SpeechSynthesisUtterance = Utt;
    const calls: string[] = [];
    const spoken: Utt[] = [];
    const synth = {
      speak: (u: Utt) => {
        calls.push("speak");
        spoken.push(u);
      },
      cancel: () => calls.push("cancel"),
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      getVoices: () => [{ voiceURI: "v1", name: "V" }],
    } as unknown as SpeechSynthesis;
    return { synth, calls, spoken };
  };
  it("play after pause then stop resumes the engine", () => {
    const { synth, calls } = setup();
    const t = createTts({ chunks: ["a", "b"], synth });
    t.play();
    t.pause();
    t.stop();
    calls.length = 0;
    t.play();
    expect(t.state).toBe("playing");
    expect(calls).toEqual(["cancel", "resume", "speak"]);
  });
  it("applies a voice chosen before play and advances chunks", () => {
    const { synth, spoken } = setup();
    const seen: number[] = [];
    const t = createTts({ chunks: ["a", "b"], synth, onChunk: (i) => seen.push(i) });
    t.setVoice("v1");
    t.play();
    expect(spoken[0]!.voice).toEqual({ voiceURI: "v1", name: "V" });
    spoken[0]!.onend!();
    expect(seen).toEqual([0, 1]);
    spoken[1]!.onend!();
    expect(t.state).toBe("idle");
  });
});
