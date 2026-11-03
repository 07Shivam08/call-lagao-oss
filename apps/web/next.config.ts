import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Next only loads apps/web/.env*; also pick up the repo-root .env (real env vars still win).
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@call-lagao/shared", "@call-lagao/web-sdk"],
  // The browser always talks to the dashboard origin; Next proxies /api/* to the API so the
  // HttpOnly `cl_session` cookie is first-party.
  async rewrites() {
    // Only the public API is proxied; /internal/* (worker API) must never be reachable via the dashboard.
    return [
      { source: "/api/v1/:path*", destination: `${apiInternalUrl}/v1/:path*` },
      { source: "/api/health", destination: `${apiInternalUrl}/health` },
    ];
  },
};

export default nextConfig;
