import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "cl_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Format: `scrypt$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `cl_live_${randomToken(24)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export type AuthContext = { orgId: string; userId: string | null; via: "session" | "api_key" };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export async function createSession(db: Db, userId: string, orgId: string): Promise<string> {
  const token = randomToken();
  await db.query(`insert into sessions (token_hash, user_id, org_id, expires_at) values ($1, $2, $3, $4)`, [
    sha256(token),
    userId,
    orgId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Resolve the caller from `Authorization: Bearer cl_live_…` or the session cookie. */
export async function authenticate(db: Db, req: FastifyRequest): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const key = header.slice(7).trim();
    const rows = await db.query(`select id, org_id from api_keys where key_hash = $1 and revoked_at is null`, [sha256(key)]);
    if (!rows[0]) throw new ApiError(401, "unauthorized", "Invalid API key");
    // best-effort usage stamp; not worth failing the request over
    db.query(`update api_keys set last_used_at = now() where id = $1`, [rows[0].id]).catch(() => undefined);
    return { orgId: rows[0].org_id, userId: null, via: "api_key" };
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const rows = await db.query(`select user_id, org_id from sessions where token_hash = $1 and expires_at > now()`, [sha256(token)]);
    if (rows[0]) return { orgId: rows[0].org_id, userId: rows[0].user_id, via: "session" };
  }
  throw new ApiError(401, "unauthorized", "Sign in or provide an API key");
}
