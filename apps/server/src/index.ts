import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, type AppDeps, type Extractor } from "./app.ts";
import { feedIntervalMinutes, startFeedScheduler } from "./scheduler.ts";
import { openDb } from "./db.ts";
import { extractFromHtml, fetchAndExtract } from "@later/core/extract";

const env = process.env;
const port = Number(env.PORT ?? 4800);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid PORT: ${env.PORT}`);
const dataDir = resolve(env.LATER_DATA_DIR || "./data");
const signupsRaw = (env.LATER_SIGNUPS ?? "on").toLowerCase();
if (signupsRaw !== "on" && signupsRaw !== "off")
  throw new Error(`LATER_SIGNUPS must be "on" or "off", got "${env.LATER_SIGNUPS}"`);
const publicUrl = (env.LATER_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");

// Real extractor (static import: startup fails if it is unavailable).
// Private/loopback targets are refused by the extractor unless LATER_ALLOW_PRIVATE_FETCH=1.
const allowPrivate = env.LATER_ALLOW_PRIVATE_FETCH === "1";
const extractor: Extractor = {
  fetchAndExtract: (url) => fetchAndExtract(url, { allowPrivate }),
  extractFromHtml: (html, url) => extractFromHtml(html, url),
};

const feedIntervalMin = feedIntervalMinutes(env.LATER_FEED_INTERVAL_MIN);

const db = openDb(dataDir);
const deps: AppDeps = {
  db,
  extract: extractor,
  config: {
    dataDir,
    signups: signupsRaw === "on",
    inboundSecret: env.LATER_INBOUND_SECRET || null,
    publicUrl,
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.LATER_MAIL_FROM || null,
    allowPrivateFetch: allowPrivate,
  },
};
const app = createApp(deps);
const stopScheduler = startFeedScheduler(deps, feedIntervalMin);

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
  stopScheduler();
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
