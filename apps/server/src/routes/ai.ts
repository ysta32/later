import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAi, type Ai, type AskDoc } from "@later/core/ai";
import { badRequest, readJson, requireAuth, type AppEnv } from "../app.ts";
import { RateLimiter } from "../auth.ts";

const MAX_QUESTION = 2000;
const ASK_DOCS = 12;

function aiOf(c: Context<AppEnv>): Ai {
  const deps = c.get("deps");
  deps.ai ??= createAi();
  return deps.ai;
}

export function aiRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Bounds LLM spend per user (summaries + questions).
  const limiter = new RateLimiter(120, 60 * 60_000);
  const limit = (c: Context<AppEnv>) => {
    if (!limiter.attempt(c.get("user").id))
      throw new HTTPException(429, { message: "AI rate limit reached" });
  };

  r.get("/ai/status", requireAuth, (c) => {
    const ai = aiOf(c);
    return c.json({ enabled: ai.enabled, model: ai.model });
  });

  r.post("/articles/:id/summary", requireAuth, async (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const a = repo.getArticle(userId, id);
    if (!a) throw new HTTPException(404, { message: "article not found" });
    if (!a.textContent.trim()) badRequest("article has no text to summarize");
    limit(c);
    const { summary, method } = await aiOf(c).summarize({ title: a.title, textContent: a.textContent });
    if (!repo.updateArticle(userId, id, { summary }))
      throw new HTTPException(404, { message: "article not found" });
    return c.json({ summary, method });
  });

  r.post("/ask", requireAuth, async (c) => {
    const body = await readJson(c);
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) badRequest("question is required");
    if (question.length > MAX_QUESTION) badRequest("question too long");
    limit(c);
    const repo = c.get("repo");
    const userId = c.get("user").id;
    let arts: { id: string; title: string; url: string; textContent: string }[] = repo.search(
      userId,
      question,
      ASK_DOCS,
    );
    if (!arts.length) arts = repo.listArticles(userId, { state: "all", limit: ASK_DOCS }).items;
    const docs: AskDoc[] = arts.map((a) => ({ id: a.id, title: a.title, url: a.url, text: a.textContent }));
    const res = await aiOf(c).ask(question, docs);
    return c.json({
      answer: res.answer,
      method: res.method,
      sources: res.sources.map((s) => ({ id: s.id, title: s.title, url: s.url })),
    });
  });

  return r;
}
