import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { readFileSync } from "node:fs";
import type { Extracted, User } from "@later/core";
import type { Ai } from "@later/core/ai";
import type { Db } from "./db.ts";
import { Repo } from "./repo.ts";
import { createLimiters, SESSION_COOKIE, type Limiters } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { articleRoutes } from "./routes/articles.ts";
import { highlightRoutes } from "./routes/highlights.ts";
import { channelRoutes, shareRoutes } from "./routes/channels.ts";
import { feedRoutes, type FeedFetcher } from "./routes/feeds.ts";
import { ioRoutes, resumePending, TaskQueue } from "./routes/io.ts";
import { aiRoutes } from "./routes/ai.ts";
import type { Mailer } from "./mailer.ts";

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
  /** From address for outbound mail (default later@<publicUrl host>). */
  mailFrom?: string | null;
  /** Allow server-side fetches (feeds) of private/loopback addresses (LATER_ALLOW_PRIVATE_FETCH=1). */
  allowPrivateFetch?: boolean;
}

export interface AppDeps {
  db: Db;
  extract: Extractor;
  config: AppConfig;
  /** AI client (default: createAi() from the environment; falls back to non-LLM paths). */
  ai?: Ai;
  /** Outbound mailer (default: nodemailer over config.smtpUrl). */
  mailer?: Mailer;
  /** Fetch a feed document as text (default: SSRF-guarded HTTP fetch with a 15 s timeout). */
  fetchFeed?: FeedFetcher;
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
    queue: TaskQueue;
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
/** Per-route body limits (as "METHOD path"); everything else under /api gets DEFAULT_BODY_LIMIT. */
export const LARGE_BODY_ROUTES = new Map<string, number>([
  ["POST /api/articles", LARGE_BODY_LIMIT],
  ["POST /api/import", 50 * 1024 * 1024],
  ["POST /api/inbound/email", 25 * 1024 * 1024],
]);

const tooLarge = (c: Context) => c.json({ error: "request body too large" }, 413);
const smallBody = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT, onError: tooLarge });
const routeBodyLimits = new Map(
  [...LARGE_BODY_ROUTES].map(([route, maxSize]) => [route, bodyLimit({ maxSize, onError: tooLarge })]),
);

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const CORS_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type";

/**
 * CORS for /api/*: any Origin may call the API, but only with an `Authorization: Bearer` token
 * (extension/bookmarklet); credentials (cookies) are never allowed cross-origin. Preflights are
 * answered only when they ask to send Authorization. Cookie requests get no CORS headers, so they
 * stay same-origin (and state changes are additionally CSRF-checked by requireAuth).
 */
const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  if (c.req.method === "OPTIONS" && origin !== undefined && c.req.header("access-control-request-method")) {
    const reqHeaders = (c.req.header("access-control-request-headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());
    const headers: Record<string, string> = { Vary: "Origin, Access-Control-Request-Headers" };
    if (reqHeaders.includes("authorization")) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = CORS_METHODS;
      headers["Access-Control-Allow-Headers"] = CORS_HEADERS;
      headers["Access-Control-Max-Age"] = "600";
    }
    return c.body(null, 204, headers);
  }
  await next();
  if (origin === undefined || !/^Bearer\s+\S+\s*$/i.test(c.req.header("authorization") ?? "")) return;
  const set = (h: Headers) => {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Expose-Headers", "Content-Disposition");
    h.delete("Access-Control-Allow-Credentials");
    h.append("Vary", "Origin");
  };
  try {
    set(c.res.headers);
  } catch {
    // Immutable headers (e.g. a passed-through Response): re-wrap and retry.
    c.res = new Response(c.res.body, c.res);
    set(c.res.headers);
  }
};

export type LaterApp = Hono<AppEnv> & {
  /** Resolves once all background jobs (e.g. import fetches) have finished. */
  drain(): Promise<void>;
  /** Re-enqueue articles left "pending" (call once at boot; idempotent). Returns the number queued. */
  resumePending(): number;
};

export function createApp(deps: AppDeps): LaterApp {
  const app = new Hono<AppEnv>();
  const repo = new Repo(deps.db);
  const limiters = createLimiters();
  const queue = new TaskQueue(3);

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("repo", repo);
    c.set("limiters", limiters);
    c.set("queue", queue);
    await next();
  });

  app.use("/api/*", cors);

  app.use("/api/*", (c, next) =>
    (routeBodyLimits.get(`${c.req.method} ${c.req.path}`) ?? smallBody)(c, next),
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
  app.get("/api/health", (c) => c.json({ ok: true, version: VERSION }));
  app.route("/api", channelRoutes());
  app.route("/api", feedRoutes());
  app.route("/api", ioRoutes());
  app.route("/api", aiRoutes());
  app.route("/", shareRoutes());

  app.notFound((c) =>
    c.req.path.startsWith("/api/") || c.req.path === "/api"
      ? c.json({ error: "not found" }, 404)
      : c.text("Not found", 404),
  );
  return Object.assign(app, {
    drain: () => queue.drain(),
    resumePending: () => resumePending(queue, repo, deps.extract),
  });
}
