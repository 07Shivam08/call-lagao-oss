import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

const rootEnv = resolve(REPO_ROOT, ".env");
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, quiet: true });

const str = (name: string, fallback = "") => (process.env[name] ?? fallback).trim();

export type Env = {
  port: number;
  apiBaseUrl: string;
  webOrigin: string;
  databaseUrl: string;
  dataDir: string;
  internalSecret: string;
  production: boolean;
  /** Session cookies get the Secure flag (HTTPS). */
  cookieSecure: boolean;
  /** "first" = only until the first account exists (default), "true" = always, "false" = never. */
  allowSignup: "first" | "true" | "false";
  /** Let webhooks target loopback/private addresses (local development only). */
  allowPrivateUrls: boolean;
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string; sipOutboundTrunkId: string };
  openaiApiKey: string;
  /** Caller IDs (E.164) that outbound phone calls may use. Empty = phone calls disabled. */
  sipFromNumbers: string[];
};

export function readEnv(): Env {
  return {
    port: Number(str("API_PORT", "4000")),
    apiBaseUrl: str("API_BASE_URL", "http://localhost:4000"),
    webOrigin: str("WEB_ORIGIN", "http://localhost:3000"),
    databaseUrl: str("DATABASE_URL"),
    dataDir: resolve(REPO_ROOT, ".data/pglite"),
    internalSecret: str("INTERNAL_API_SECRET"),
    production: str("NODE_ENV") === "production",
    cookieSecure: str("NODE_ENV") === "production" || str("WEB_ORIGIN").startsWith("https:"),
    allowSignup: (["true", "false"].includes(str("ALLOW_SIGNUP").toLowerCase()) ? str("ALLOW_SIGNUP").toLowerCase() : "first") as Env["allowSignup"],
    allowPrivateUrls: ["1", "true", "yes"].includes(str("ALLOW_PRIVATE_URLS").toLowerCase()),
    livekit: {
      url: str("LIVEKIT_URL"),
      apiKey: str("LIVEKIT_API_KEY"),
      apiSecret: str("LIVEKIT_API_SECRET"),
      agentName: str("LIVEKIT_AGENT_NAME", "call-lagao-agent"),
      sipOutboundTrunkId: str("LIVEKIT_SIP_OUTBOUND_TRUNK_ID"),
    },
    openaiApiKey: str("OPENAI_API_KEY"),
    sipFromNumbers: str("SIP_FROM_NUMBERS").split(",").map((n) => n.trim()).filter(Boolean),
  };
}

const PLACEHOLDER = /change-?me|example|placeholder|secret$/i;

/** Problems with INTERNAL_API_SECRET; any problem is fatal in production. */
export function internalSecretProblem(secret: string): string | null {
  if (!secret) return "INTERNAL_API_SECRET is required (see .env.example)";
  if (secret.length < 32 || PLACEHOLDER.test(secret)) {
    return "INTERNAL_API_SECRET looks like a placeholder or is shorter than 32 characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";
  }
  return null;
}
