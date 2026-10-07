import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { Extracted, User } from "@later/core";
import type { Db } from "./db.ts";
import { Repo } from "./repo.ts";
import { createLimiters, SESSION_COOKIE, type Limiters } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { articleRoutes } from "./routes/articles.ts";
import { highlightRoutes } from "./routes/highlights.ts";

export interface Extractor {
  fetchAndExtract(url: string): Promise<Extracted>;
  extractFromHtml(html: string, url: string): Extracted;
}

export interface AppConfig {
  dataDir: string;
  signups: boolean;
  inboundSecret: string | null;
  publicUrl: string;
  smtpUrl: string | null;
}

export interface AppDeps {
  db: Db;
  extract: Extractor;
  config: AppConfig;
}

export type AppEnv = {
  Variables: {
    user: User;
    /** Raw bearer/cookie token that authenticated this request. */
    authToken: string;
    authVia: "bearer" | "cookie";
    repo: Repo;
    deps: AppDeps;
    limiters: Limiters;
  };
};

type NodeEnvLike = { incoming?: { socket?: { remoteAddress?: string } } } | undefined;

export function clientIp(c: Context): string {
  return (c.env as NodeEnvLike)?.incoming?.socket?.remoteAddress ?? "unknown";
}

/** Extract the request's credential: Authorization: Bearer wins over the session cookie. */
export function readToken(c: Context): { token: string; via: "bearer" | "cookie" } | null {
  const h = c.req.header("authorization");
  if (h) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    return m ? { token: m[1], via: "bearer" } : null;
  }
  const ck = getCookie(c, SESSION_COOKIE);
  return ck ? { token: ck, via: "cookie" } : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True if `origin` (an Origin header value) names this server. */
function originAllowed(c: Context<AppEnv>, origin: string): boolean {
  if (origin === "null") return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const reqHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (reqHost) allowed.add(reqHost.split(",")[0].trim());
  try {
    allowed.add(new URL(c.req.url).host);
  } catch {
    /* relative URL in tests */
  }
  try {
    allowed.add(new URL(c.get("deps").config.publicUrl).host);
  } catch {
    /* unset/invalid publicUrl */
  }
  return allowed.has(host);
}

/**
 * CSRF guard for browser-reachable state changes. A present Origin must name this server and a
 * present Sec-Fetch-Site must be same-origin/none. When `requireSignal` is set (the request is
 * authenticated by cookie), a request carrying neither header is rejected too.
 */
export function assertSameOrigin(c: Context<AppEnv>, requireSignal: boolean): void {
  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  const reject = () => {
    throw new HTTPException(403, { message: "cross-origin request rejected" });
  };
  if (site !== undefined && site !== "same-origin" && site !== "none") reject();
  if (origin !== undefined && !originAllowed(c, origin)) reject();
  if (requireSignal && origin === undefined && site === undefined) reject();
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cred = readToken(c);
  const user = cred ? c.get("repo").userForToken(cred.token) : null;
  if (!cred || !user) throw new HTTPException(401, { message: "unauthorized" });
  if (cred.via === "cookie" && !SAFE_METHODS.has(c.req.method)) assertSameOrigin(c, true);
  c.set("user", user);
  c.set("authToken", cred.token);
  c.set("authVia", cred.via);
  await next();
};

/** Parse a JSON object body; 415 unless Content-Type is application/json, 400 on malformed input. */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json")
    throw new HTTPException(415, { message: "Content-Type must be application/json" });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HTTPException(400, { message: "expected a JSON object" });
  return body as Record<string, unknown>;
}

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const LARGE_BODY_LIMIT = 20 * 1024 * 1024;
/** Routes allowed LARGE_BODY_LIMIT (as "METHOD path"); everything else under /api gets DEFAULT_BODY_LIMIT. */
export const LARGE_BODY_ROUTES = new Set<string>(["POST /api/articles"]);

const tooLarge = (c: Context) => c.json({ error: "request body too large" }, 413);
const smallBody = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError: tooLarge });
const largeBody = bodyLimit({ maxSize: LARGE_BODY_LIMIT, onError: tooLarge });

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const repo = new Repo(deps.db);
  const limiters = createLimiters();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("repo", repo);
    c.set("limiters", limiters);
    await next();
  });

  app.use("/api/*", (c, next) =>
    LARGE_BODY_ROUTES.has(`${c.req.method} ${c.req.path}`) ? largeBody(c, next) : smallBody(c, next),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message || "error" }, err.status);
    }
    console.error("[later] unhandled error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  app.route("/api", authRoutes());
  app.route("/api", articleRoutes());
  app.route("/api", highlightRoutes());

  app.notFound((c) =>
    c.req.path.startsWith("/api/") || c.req.path === "/api"
      ? c.json({ error: "not found" }, 404)
      : c.text("Not found", 404),
  );
  return app;
}
