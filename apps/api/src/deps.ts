import type { Db } from "./db.js";
import type { Env } from "./env.js";
import type { Analyzer } from "./services/analysis.js";
import type { LifecycleDeps } from "./services/calls.js";
import type { VoiceGateway } from "./services/voice.js";
import type { WebhookOptions } from "./services/webhooks.js";

export type Deps = {
  db: Db;
  env: Env;
  voice: VoiceGateway;
  analyzer: Analyzer;
  webhooks: WebhookOptions;
  /** Fire-and-forget work (webhooks, analysis). Tests await it via `drain()`. */
  background: (p: Promise<unknown>) => void;
};

export const lifecycle = (d: Deps): LifecycleDeps => ({ db: d.db, analyzer: d.analyzer, webhooks: d.webhooks, background: d.background });
