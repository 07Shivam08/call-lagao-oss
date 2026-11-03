import { z } from "zod";

/** Tool names are exposed to the LLM, so keep them function-name safe. */
const toolName = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/, "letters, digits and underscores only");

export const EndCallTool = z.object({
  type: z.literal("end_call"),
  name: toolName.default("end_call"),
  description: z.string().default("End the call when the conversation is complete or the user asks to hang up."),
});

export const CustomTool = z.object({
  type: z.literal("custom"),
  name: toolName,
  description: z.string().min(1),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  /** JSON Schema (type: object) describing the arguments the LLM must produce. */
  parameters: z
    .object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.any()).default({}),
      required: z.array(z.string()).optional(),
    })
    .default({ type: "object", properties: {} }),
  timeout_ms: z.number().int().min(1000).max(120_000).default(10_000),
  /** Say a short filler line while the request runs. */
  speak_during_execution: z.boolean().default(false),
  execution_message: z.string().optional(),
});

export const Tool = z.discriminatedUnion("type", [EndCallTool, CustomTool]);
export type Tool = z.infer<typeof Tool>;

export const AnalysisField = z.object({
  name: toolName,
  type: z.enum(["string", "boolean", "number", "enum"]),
  description: z.string().default(""),
  choices: z.array(z.string()).optional(),
});
export type AnalysisField = z.infer<typeof AnalysisField>;

export const LLM_MODELS = ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"] as const;
export const TTS_PROVIDERS = ["elevenlabs", "cartesia", "openai"] as const;

export const AgentConfig = z.object({
  engine: z
    .object({
      type: z.literal("prompt").default("prompt"),
      prompt: z.string().default("You are a friendly, concise voice assistant."),
      /** null = let the LLM generate the greeting; "" = wait for the user to speak first. */
      begin_message: z.string().nullable().default("Hi! How can I help you today?"),
      start_speaker: z.enum(["agent", "user"]).default("agent"),
      model: z.string().default("gpt-4.1-mini"),
      temperature: z.number().min(0).max(2).default(0.4),
      tools: z.array(Tool).default([{ type: "end_call", name: "end_call", description: "End the call when the conversation is complete or the user asks to hang up." }]),
    })
    .prefault({}),
  voice: z
    .object({
      provider: z.enum(TTS_PROVIDERS).default("elevenlabs"),
      voice_id: z.string().default("21m00Tcm4TlvDq8ikWAM"),
      model: z.string().optional(),
      speed: z.number().min(0.5).max(2).default(1),
    })
    .prefault({}),
  stt: z
    .object({
      provider: z.literal("deepgram").default("deepgram"),
      model: z.string().default("nova-3"),
      /** BCP-47 code, or "multi" for code-switching. */
      language: z.string().default("en"),
    })
    .prefault({}),
  turn: z
    .object({
      /** 0 = agent can never be interrupted, 1 = any speech interrupts. */
      interruption_sensitivity: z.number().min(0).max(1).default(0.8),
      /** 0 = waits long before replying, 1 = replies as soon as possible. */
      responsiveness: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
  call: z
    .object({
      max_call_duration_ms: z.number().int().min(60_000).max(7_200_000).default(1_800_000),
      end_call_after_silence_ms: z.number().int().min(10_000).max(3_600_000).default(60_000),
    })
    .prefault({}),
  analysis: z
    .object({
      model: z.string().default("gpt-4.1-mini"),
      fields: z.array(AnalysisField).default([]),
    })
    .prefault({}),
  /** Per-agent webhook (in addition to the org webhook). */
  webhook_url: z.string().url().nullable().default(null),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export type AgentConfigInput = z.input<typeof AgentConfig>;

export const defaultAgentConfig = (): AgentConfig => AgentConfig.parse({});

/** Replace `{{name}}` with dynamic variable values; unknown variables are left as-is. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}
