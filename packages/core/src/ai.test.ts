import { describe, it, expect, vi } from "vitest";
import { createAi, extractiveSummary, type AiClient } from "./ai.ts";

function fake(res: unknown | Error) {
  const create = vi.fn(async (_p: unknown) => {
    if (res instanceof Error) throw res;
    return res as { content: { type: string; text?: string }[]; stop_reason?: string };
  });
  return { client: { beta: { messages: { create } } } as unknown as AiClient, create };
}

const article = {
  title: "Cats",
  textContent:
    "Cats sleep a lot. Cats are mammals that purr. Dogs bark loudly. Cats chase mice at night. Weather is nice.",
};
const docs = [
  { id: "1", title: "Cats", url: "http://a", text: "Cats purr when happy. They sleep long." },
  { id: "2", title: "Dogs", url: "http://b", text: "Dogs bark loudly at strangers." },
];

describe("ai", () => {
  it("sends correct request shape and extracts only text blocks", async () => {
    const { client, create } = fake({
      stop_reason: "end_turn",
      content: [{ type: "thinking" }, { type: "text", text: "A summary." }],
    });
    const ai = createAi({ client });
    expect(ai.enabled).toBe(true);
    const r = await ai.summarize(article);
    expect(r).toEqual({ summary: "A summary.", method: "claude" });
    const p = create.mock.calls[0][0] as Record<string, unknown>;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("temperature");
    const msgs = p.messages as { role: string }[];
    expect(msgs.every((m) => m.role === "user")).toBe(true);
  });

  it("refusal falls back to extractive", async () => {
    const { client } = fake({ stop_reason: "refusal", content: [{ type: "text", text: "no" }] });
    const r = await createAi({ client }).summarize(article);
    expect(r.method).toBe("extractive");
    expect(r.summary).toBe(extractiveSummary(article.textContent));
  });

  it("thrown error falls back", async () => {
    const { client } = fake(new Error("boom"));
    const ai = createAi({ client });
    expect((await ai.summarize(article)).method).toBe("extractive");
    expect((await ai.ask("cats purr", docs)).method).toBe("search");
  });

  it("ask with claude returns sources", async () => {
    const { client, create } = fake({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Cats purr [1]." }],
    });
    const r = await createAi({ client }).ask("Do cats purr?", docs);
    expect(r).toEqual({ answer: "Cats purr [1].", method: "claude", sources: docs });
    const msg = (create.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
    expect(msg).toContain("<article");
  });

  it("disabled path is deterministic", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const ai = createAi();
      expect(ai.enabled).toBe(false);
      const a = await ai.ask("do cats purr", docs);
      expect(a.method).toBe("search");
      expect(a.sources).toEqual([docs[0]]);
      expect(a.answer).toBe("- Cats: Cats purr when happy.");
      expect(await ai.ask("do cats purr", docs)).toEqual(a);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("extractiveSummary keeps original order", () => {
    const s = extractiveSummary(article.textContent, 2);
    const idx = s.split(". ").length;
    expect(idx).toBeLessThanOrEqual(2);
    expect(article.textContent.indexOf(s.split(".")[0])).toBeGreaterThanOrEqual(0);
  });
});
