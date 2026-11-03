import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { authenticate } from "./auth.js";
import type { Deps } from "./deps.js";
import { ApiError, registerErrorHandler } from "./errors.js";
import { accountRoutes } from "./routes/account.js";
import { agentRoutes } from "./routes/agents.js";
import { callRoutes, internalRoutes } from "./routes/calls.js";
import { metaRoutes } from "./routes/meta.js";

const PUBLIC_ROUTES = new Set(["/v1/auth/signup", "/v1/auth/login", "/v1/auth/logout", "/v1/meta/options", "/health"]);

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  registerErrorHandler(app);
  await app.register(cookie);
  await app.register(cors, { origin: [deps.env.webOrigin], credentials: true, methods: ["GET", "POST", "PATCH", "DELETE"] });

  app.addHook("onRequest", async (req) => {
    // Use the matched route pattern, not req.url: the router decodes percent-escapes
    // (e.g. "/%69nternal/..."), so a raw-URL prefix check could be bypassed.
    // Unmatched routes have no pattern and fall through to the 404 handler.
    const path = req.routeOptions.url ?? "";
    if (path.startsWith("/internal/")) {
      const given = String(req.headers["x-internal-secret"] ?? "");
      if (!deps.env.internalSecret || !safeEqual(given, deps.env.internalSecret)) throw new ApiError(401, "unauthorized", "Bad internal secret");
      return;
    }
    if (path.startsWith("/v1/") && !PUBLIC_ROUTES.has(path)) {
      req.auth = await authenticate(deps.db, req);
    }
  });

  metaRoutes(app, deps);
  accountRoutes(app, deps);
  agentRoutes(app, deps);
  callRoutes(app, deps);
  internalRoutes(app, deps);
  return app;
}
