import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 1024;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "later_session";

function scryptAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  len: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, len, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Hash format: scrypt$N$r$p$saltb64$hashb64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]),
    r = Number(parts[2]),
    p = Number(parts[3]);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (expected.length === 0) return false;
  const key = await scryptAsync(password, salt, n, r, p, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | null = null;
/** Burn equivalent CPU for unknown users so login timing does not reveal account existence. */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/** In-memory fixed-window limiter for failed login attempts, keyed by IP+email. */
export class LoginLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private max: number;
  private windowMs: number;
  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  private key(ip: string, email: string): string {
    return `${ip}\u0000${email}`;
  }
  blocked(ip: string, email: string, now = Date.now()): boolean {
    const h = this.hits.get(this.key(ip, email));
    if (!h) return false;
    if (h.resetAt <= now) {
      this.hits.delete(this.key(ip, email));
      return false;
    }
    return h.count >= this.max;
  }
  fail(ip: string, email: string, now = Date.now()): void {
    const k = this.key(ip, email);
    const h = this.hits.get(k);
    if (!h || h.resetAt <= now) this.hits.set(k, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
    if (this.hits.size > 10_000) this.prune(now);
  }
  reset(ip: string, email: string): void {
    this.hits.delete(this.key(ip, email));
  }
  private prune(now: number): void {
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
    // Still too big (attack with many keys): drop oldest entries (Map preserves insertion order).
    for (const k of this.hits.keys()) {
      if (this.hits.size <= 10_000) break;
      this.hits.delete(k);
    }
  }
}
