import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { badRequest, readJson, requireAuth, type AppEnv } from "../app.ts";
import { HIGHLIGHT_COLORS, type HighlightColor } from "../repo.ts";

const MAX_QUOTE = 20_000;
const MAX_NOTE = 20_000;

function parseColor(v: unknown): HighlightColor {
  if (typeof v !== "string" || !(HIGHLIGHT_COLORS as readonly string[]).includes(v))
    badRequest(`color must be one of ${HIGHLIGHT_COLORS.join(", ")}`);
  return v as HighlightColor;
}

function parseNote(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") badRequest("note must be a string or null");
  if (v.length > MAX_NOTE) badRequest("note too long");
  return v;
}

function optString(v: unknown, name: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") badRequest(`${name} must be a string`);
  return v;
}

export function highlightRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/articles/:id/highlights", requireAuth, (c) => {
    const repo = c.get("repo");
    const userId = c.get("user").id;
    const articleId = c.req.param("id");
    if (!repo.getArticle(userId, articleId)) throw new HTTPException(404, { message: "article not found" });
    return c.json({ items: repo.listHighlights(userId, articleId) });
  });

  r.post("/articles/:id/highlights", requireAuth, async (c) => {
    const body = await readJson(c);
    const quote = body.quote;
    if (typeof quote !== "string" || !quote.trim()) badRequest("quote is required");
    if (quote.length > MAX_QUOTE) badRequest("quote too long");
    const h = c.get("repo").createHighlight(c.get("user").id, c.req.param("id"), {
      quote,
      prefix: optString(body.prefix, "prefix"),
      suffix: optString(body.suffix, "suffix"),
      note: body.note === undefined ? null : parseNote(body.note),
      color: body.color === undefined ? "yellow" : parseColor(body.color),
    });
    if (!h) throw new HTTPException(404, { message: "article not found" });
    return c.json(h, 201);
  });

  r.patch("/highlights/:id", requireAuth, async (c) => {
    const body = await readJson(c);
    const patch: { note?: string | null; color?: HighlightColor } = {};
    if (body.note !== undefined) patch.note = parseNote(body.note);
    if (body.color !== undefined) patch.color = parseColor(body.color);
    const h = c.get("repo").updateHighlight(c.get("user").id, c.req.param("id"), patch);
    if (!h) throw new HTTPException(404, { message: "highlight not found" });
    return c.json(h);
  });

  r.delete("/highlights/:id", requireAuth, (c) => {
    if (!c.get("repo").deleteHighlight(c.get("user").id, c.req.param("id")))
      throw new HTTPException(404, { message: "highlight not found" });
    return c.body(null, 204);
  });

  r.get("/highlights", requireAuth, (c) =>
    c.json({ items: c.get("repo").listAllHighlights(c.get("user").id) }),
  );

  return r;
}
