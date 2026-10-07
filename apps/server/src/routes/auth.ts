import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  readJson,
  readToken,
  requireAuth,
  type AppEnv,
} from "../app.ts";
import {
  hashPassword,
  MAX_PASSWORD,
  MIN_PASSWORD,
  normalizeEmail,
  SESSION_COOKIE,
  SESSION_DAYS,
  verifyDummy,
  verifyPassword,
} from "../auth.ts";

function secureCookie(c: Context<AppEnv>): boolean {
  return c.get("deps").config.publicUrl.toLowerCase().startsWith("https:");
}

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookie(c),
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

function readCredentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = normalizeEmail(body.email);
  if (!email) badRequest("a valid email is required");
  const password = body.password;
  if (typeof password !== "string" || !password) badRequest("password is required");
  if (password.length > MAX_PASSWORD) badRequest("password too long");
  return { email, password };
}

export function authRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/auth/signup", async (c) => {
    // Sets a session cookie, so browser requests must be same-origin (blocks login CSRF).
    assertSameOrigin(c, false);
    const repo = c.get("repo");
    const { config } = c.get("deps");
    const { email, password } = readCredentials(await readJson(c));
    if (password.length < MIN_PASSWORD) badRequest(`password must be at least ${MIN_PASSWORD} characters`);
    if (!c.get("limiters").signup.attempt(clientIp(c)))
      throw new HTTPException(429, { message: "too many signup attempts; try again later" });
    // Cheap pre-check so a closed instance does not burn scrypt CPU; re-checked after hashing.
    if (!config.signups && repo.countUsers() > 0)
      throw new HTTPException(403, { message: "signups are disabled" });
    const hash = await hashPassword(password);
    // Synchronous from here on: no interleaving between the checks and the insert.
    if (!config.signups && repo.countUsers() > 0)
      throw new HTTPException(403, { message: "signups are disabled" });
    if (repo.getUserByEmail(email))
      throw new HTTPException(409, { message: "an account with this email already exists" });
    const user = repo.createUser(email, hash);
    const token = repo.createSession(user.id, "session");
    setSessionCookie(c, token);
    return c.json({ user, token }, 201);
  });

  r.post("/auth/login", async (c) => {
    assertSameOrigin(c, false);
    const repo = c.get("repo");
    const limiter = c.get("limiters").login;
    const { email, password } = readCredentials(await readJson(c));
    const key = `${clientIp(c)}\u0000${email}`;
    // Reserve the attempt before the (async) scrypt so concurrent guesses cannot exceed the limit.
    if (!limiter.attempt(key))
      throw new HTTPException(429, { message: "too many login attempts; try again later" });
    const user = repo.getUserByEmail(email);
    const hash = user ? repo.getPasswordHash(user.id) : null;
    const ok = user && hash ? await verifyPassword(password, hash) : await verifyDummy(password);
    if (!ok || !user) throw new HTTPException(401, { message: "invalid email or password" });
    limiter.refund(key);
    repo.pruneSessions();
    const token = repo.createSession(user.id, "session");
    setSessionCookie(c, token);
    return c.json({ user, token });
  });

  r.post("/auth/logout", (c) => {
    const cred = readToken(c);
    assertSameOrigin(c, cred?.via === "cookie");
    // Only revoke browser sessions here; API tokens are long-lived credentials and are not revoked by logout.
    if (cred) {
      const repo = c.get("repo");
      if (repo.sessionKind(cred.token) === "session") repo.deleteSession(cred.token);
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookie(c), httpOnly: true, sameSite: "Lax" });
    return c.body(null, 204);
  });

  r.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

  r.patch("/me", requireAuth, async (c) => {
    const body = await readJson(c);
    const patch: { kindleEmail?: string | null } = {};
    if ("kindleEmail" in body) {
      const v = body.kindleEmail;
      if (v === null || v === "") patch.kindleEmail = null;
      else {
        const e = normalizeEmail(v);
        if (!e) badRequest("kindleEmail must be a valid email or null");
        patch.kindleEmail = e;
      }
    }
    const user = c.get("repo").updateUser(c.get("user").id, patch);
    if (!user) throw new HTTPException(404, { message: "user not found" });
    return c.json({ user });
  });

  r.post("/tokens", requireAuth, async (c) => {
    const body = await readJson(c);
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) : "";
    if (!label) badRequest("label is required");
    if (!c.get("limiters").tokens.attempt(clientIp(c)))
      throw new HTTPException(429, { message: "too many tokens created; try again later" });
    const token = c.get("repo").createSession(c.get("user").id, "api", label);
    return c.json({ token }, 201);
  });

  return r;
}
