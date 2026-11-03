import { z } from "zod";
import type { AgentConfig } from "./agent.js";

export const CALL_STATUSES = ["registered", "ongoing", "ended", "not_connected", "error"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const DISCONNECTION_REASONS = [
  "user_hangup",
  "agent_hangup",
  "manual_stopped",
  "inactivity",
  "max_duration_reached",
  "dial_failed",
  "dial_no_answer",
  "dial_busy",
  "concurrency_limit_reached",
  "error_llm",
  "error_stt",
  "error_tts",
  "error_worker",
  "error_unknown",
] as const;
export type DisconnectionReason = (typeof DISCONNECTION_REASONS)[number];

/** One entry of `call.transcript`. Times are ms from call start. */
export const TranscriptItem = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("agent"),
    content: z.string(),
    start_ms: z.number().optional(),
    end_ms: z.number().optional(),
    interrupted: z.boolean().optional(),
  }),
  z.object({
    role: z.literal("user"),
    content: z.string(),
    start_ms: z.number().optional(),
    end_ms: z.number().optional(),
  }),
  z.object({
    role: z.literal("tool_call_invocation"),
    tool_call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    time_ms: z.number().optional(),
  }),
  z.object({
    role: z.literal("tool_call_result"),
    tool_call_id: z.string(),
    content: z.string(),
    successful: z.boolean(),
    time_ms: z.number().optional(),
  }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;

/** Raw per-turn samples the worker reports; the API turns them into distributions. */
export const LatencySamples = z.object({
  e2e: z.array(z.number()).default([]),
  stt: z.array(z.number()).default([]),
  llm: z.array(z.number()).default([]),
  tts: z.array(z.number()).default([]),
});
export type LatencySamples = z.infer<typeof LatencySamples>;

export const UsageReport = z.object({
  llm_model: z.string().optional(),
  llm_prompt_tokens: z.number().default(0),
  llm_completion_tokens: z.number().default(0),
  llm_requests: z.number().default(0),
  tts_provider: z.string().optional(),
  tts_characters: z.number().default(0),
  stt_audio_seconds: z.number().default(0),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** Worker → API: POST /internal/calls/:id/started */
export const CallStartedReport = z.object({
  started_at: z.number(), // epoch ms
});

/** Worker → API: POST /internal/calls/:id/ended */
export const CallEndedReport = z.object({
  ended_at: z.number(), // epoch ms
  /** When the caller joined/answered (epoch ms). Lets the API recover if the `started` report was lost. */
  started_at: z.number().optional(),
  disconnection_reason: z.enum(DISCONNECTION_REASONS),
  transcript: z.array(TranscriptItem).default([]),
  collected_variables: z.record(z.string(), z.string()).default({}),
  latency: LatencySamples.prefault({}),
  usage: UsageReport.prefault({}),
  error_message: z.string().optional(),
});
export type CallEndedReport = z.infer<typeof CallEndedReport>;

export type Distribution = {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  num: number;
  values: number[];
};

export type ProductCost = { product: string; unit: "second" | "call" | "1k_tokens"; quantity: number; unit_price: number; cost: number };

/** All money values are US cents (fractional allowed). */
export type CallCost = {
  combined_cost: number;
  product_costs: ProductCost[];
  total_duration_seconds: number;
};

export type CallAnalysis = {
  call_summary: string;
  call_successful: boolean;
  user_sentiment: "Positive" | "Neutral" | "Negative" | "Unknown";
  custom_analysis_data: Record<string, unknown>;
};

/** Public call object returned by the API and sent in webhooks. Timestamps are epoch ms. */
export type Call = {
  call_id: string;
  call_type: "web_call" | "phone_call";
  direction: "inbound" | "outbound" | null;
  agent_id: string;
  agent_version: number;
  agent_name: string | null;
  call_status: CallStatus;
  from_number: string | null;
  to_number: string | null;
  start_timestamp: number | null;
  end_timestamp: number | null;
  duration_ms: number | null;
  disconnection_reason: DisconnectionReason | null;
  dynamic_variables: Record<string, string>;
  collected_variables: Record<string, string>;
  metadata: Record<string, unknown>;
  transcript: TranscriptItem[];
  latency: Partial<Record<keyof LatencySamples, Distribution>>;
  usage: UsageReport | null;
  call_cost: CallCost | null;
  call_analysis: CallAnalysis | null;
  recording_url: string | null;
  created_timestamp: number;
};

/** API → worker: GET /internal/calls/:id/context */
export type CallContext = {
  call: Pick<Call, "call_id" | "call_type" | "direction" | "agent_id" | "agent_version" | "from_number" | "to_number" | "metadata">;
  agent_name: string;
  agent_config: AgentConfig;
  dynamic_variables: Record<string, string>;
};

export type WebhookEvent = "call_started" | "call_ended" | "call_analyzed";
