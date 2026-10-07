import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, type Extractor } from "./app.ts";
import { openDb } from "./db.ts";

const env = process.env;
const port = Number(env.PORT ?? 4800);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid PORT: ${env.PORT}`);
const dataDir = resolve(env.LATER_DATA_DIR || "./data");
const signupsRaw = (env.LATER_SIGNUPS ?? "on").toLowerCase();
if (signupsRaw !== "on" && signupsRaw !== "off")
  throw new Error(`LATER_SIGNUPS must be "on" or "off", got "${env.LATER_SIGNUPS}"`);
const publicUrl = (env.LATER_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");

// Real extractor from @later/core. The specifier is held in a variable so this file type-checks
// even before core/extract.ts lands; only a missing module is tolerated (logged loudly).
const EXTRACT_MODULE: string = "@later/core/extract";
async function loadExtractor(): Promise<Extractor> {
  try {
    const mod = (await import(EXTRACT_MODULE)) as Partial<Extractor>;
    if (typeof mod.fetchAndExtract !== "function" || typeof mod.extractFromHtml !== "function") {
      throw new Error(`${EXTRACT_MODULE} does not export fetchAndExtract/extractFromHtml`);
    }
    return { fetchAndExtract: mod.fetchAndExtract, extractFromHtml: mod.extractFromHtml };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" || !String((err as Error).message).includes("extract")) throw err;
    console.error(`[later] WARNING: ${EXTRACT_MODULE} not found; article capture will be saved as failed.`);
    const unavailable = (): never => {
      throw new Error("extractor unavailable on this server");
    };
    return { fetchAndExtract: async () => unavailable(), extractFromHtml: () => unavailable() };
  }
}

const db = openDb(dataDir);
const app = createApp({
  db,
  extract: await loadExtractor(),
  config: {
    dataDir,
    signups: signupsRaw === "on",
    inboundSecret: env.LATER_INBOUND_SECRET || null,
    publicUrl,
    smtpUrl: env.SMTP_URL || null,
  },
});

// Static web app (if built), with SPA fallback to index.html for non-/api paths.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const indexHtml = resolve(webDist, "index.html");
if (existsSync(indexHtml)) {
  app.use("*", async (c, next) =>
    c.req.path.startsWith("/api/") ? next() : serveStatic({ root: webDist })(c, next),
  );
  app.get("*", (c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    return c.html(readFileSync(indexHtml, "utf8"));
  });
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[later] listening on http://localhost:${info.port} (data: ${dataDir})`);
});

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
