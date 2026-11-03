import { newId } from "@call-lagao/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, hashPassword, newApiKey, randomToken, sha256, SESSION_COOKIE, setSessionCookie, verifyPassword } from "../auth.js";
import type { Deps } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { rateLimiter } from "../rate-limit.js";
import { toOrg, toUser } from "../serialize.js";

const Signup = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(8, "at least 8 characters").max(200),
  name: z.string().max(100).optional(),
  org_name: z.string().min(1).max(100).optional(),
});
const Login = z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string().min(1) });
const OrgPatch = z.object({ name: z.string().min(1).max(100).optional(), webhook_url: z.string().url().nullable().optional() });
const KeyCreate = z.object({ name: z.string().min(1).max(100) });

const ms = (d: unknown) => (d ? new Date(d as string).getTime() : null);

export function accountRoutes(app: FastifyInstance, d: Deps) {
  const { db } = d;
  const secure = d.env.cookieSecure;
  // Brute-force protection: per email for login, per client IP for signup.
  const loginLimit = rateLimiter(10, 5 * 60_000);
  const signupLimit = rateLimiter(20, 60 * 60_000);
  // Compared against when the email is unknown, so login timing doesn't reveal which emails exist.
  const dummyHash = hashPassword(randomToken(16));

  app.post("/v1/auth/signup", async (req, reply) => {
    if (!signupLimit(req.ip)) throw new ApiError(429, "rate_limited", "Too many sign-ups, try again later");
    if (d.env.allowSignup === "false") throw new ApiError(403, "signup_disabled", "Sign-up is disabled on this server");
    if (d.env.allowSignup === "first" && (await db.query(`select 1 from users limit 1`)).length) {
      throw new ApiError(403, "signup_disabled", "Sign-up is closed on this server. Set ALLOW_SIGNUP=true to allow more accounts.");
    }
    const body = Signup.parse(req.body);
    const existing = await db.query(`select 1 from users where email = $1`, [body.email]);
    if (existing.length) throw new ApiError(409, "email_taken", "An account with this email already exists");
    const userId = newId("usr");
    const orgId = newId("org");
    const orgName = body.org_name ?? `${body.name ?? body.email.split("@")[0]}'s workspace`;
    const passwordHash = await hashPassword(body.password);
    await db.tx(async (t) => {
      await t.query(`insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)`, [userId, body.email, body.name ?? null, passwordHash]);
      await t.query(`insert into organizations (id, name, webhook_secret) values ($1, $2, $3)`, [orgId, orgName, `whsec_${randomToken(24)}`]);
      await t.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [orgId, userId]);
    });
    setSessionCookie(reply, await createSession(db, userId, orgId), secure);
    const [user] = await db.query(`select * from users where id = $1`, [userId]);
    const [org] = await db.query(`select * from organizations where id = $1`, [orgId]);
    return reply.status(201).send({ user: toUser(user!), org: toOrg(org!) });
  });

  app.post("/v1/auth/login", async (req, reply) => {
    const body = Login.parse(req.body);
    if (!loginLimit(body.email)) throw new ApiError(429, "rate_limited", "Too many login attempts, try again in a few minutes");
    const [user] = await db.query(`select * from users where email = $1`, [body.email]);
    const ok = await verifyPassword(body.password, user ? user.password_hash : await dummyHash);
    if (!user || !ok) {
      throw new ApiError(401, "invalid_credentials", "Wrong email or password");
    }
    const [m] = await db.query(`select org_id from memberships where user_id = $1 order by created_at limit 1`, [user.id]);
    if (!m) throw new ApiError(403, "no_org", "This user is not part of any workspace");
    setSessionCookie(reply, await createSession(db, user.id, m.org_id), secure);
    const [org] = await db.query(`select * from organizations where id = $1`, [m.org_id]);
    return { user: toUser(user), org: toOrg(org!) };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/session", async (req) => {
    const auth = req.auth!;
    const [org] = await db.query(`select * from organizations where id = $1`, [auth.orgId]);
    const user = auth.userId ? (await db.query(`select * from users where id = $1`, [auth.userId]))[0] : null;
    return { user: user ? toUser(user) : null, org: toOrg(org!) };
  });

  app.patch("/v1/org", async (req) => {
    const body = OrgPatch.parse(req.body);
    const [org] = await db.query(
      `update organizations set name = coalesce($2, name), webhook_url = case when $3::boolean then $4 else webhook_url end where id = $1 returning *`,
      [req.auth!.orgId, body.name ?? null, body.webhook_url !== undefined, body.webhook_url ?? null],
    );
    return toOrg(org!);
  });

  app.get("/v1/org/webhook-secret", async (req) => {
    const [org] = await db.query(`select webhook_secret from organizations where id = $1`, [req.auth!.orgId]);
    return { webhook_secret: org!.webhook_secret as string };
  });

  app.post("/v1/org/webhook-secret", async (req) => {
    const secret = `whsec_${randomToken(24)}`;
    await db.query(`update organizations set webhook_secret = $2 where id = $1`, [req.auth!.orgId, secret]);
    return { webhook_secret: secret };
  });

  app.get("/v1/api-keys", async (req) => {
    const rows = await db.query(`select * from api_keys where org_id = $1 and revoked_at is null order by created_at desc`, [req.auth!.orgId]);
    return {
      items: rows.map((r) => ({ key_id: r.id, name: r.name, key_prefix: r.key_prefix, created_timestamp: ms(r.created_at), last_used_timestamp: ms(r.last_used_at) })),
    };
  });

  app.post("/v1/api-keys", async (req, reply) => {
    const body = KeyCreate.parse(req.body);
    const { key, prefix, hash } = newApiKey();
    const id = newId("key");
    await db.query(`insert into api_keys (id, org_id, name, key_hash, key_prefix) values ($1, $2, $3, $4, $5)`, [id, req.auth!.orgId, body.name, hash, prefix]);
    return reply.status(201).send({ key_id: id, name: body.name, api_key: key });
  });

  app.delete<{ Params: { keyId: string } }>("/v1/api-keys/:keyId", async (req) => {
    const rows = await db.query(`update api_keys set revoked_at = now() where id = $1 and org_id = $2 and revoked_at is null returning id`, [
      req.params.keyId,
      req.auth!.orgId,
    ]);
    if (!rows.length) throw notFound("API key");
    return { ok: true };
  });
}
