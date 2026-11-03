import OpenAI from "openai";
import type { AgentConfig, CallAnalysis, TranscriptItem } from "@call-lagao/shared";

export interface Analyzer {
  analyze(transcript: TranscriptItem[], config: AgentConfig): Promise<CallAnalysis | null>;
}

export const noopAnalyzer: Analyzer = { analyze: async () => null };

function transcriptText(t: TranscriptItem[]): string {
  return t
    .map((i) => {
      if (i.role === "agent") return `Agent: ${i.content}`;
      if (i.role === "user") return `User: ${i.content}`;
      if (i.role === "tool_call_invocation") return `[tool ${i.name}(${i.arguments})]`;
      return `[tool result ${i.successful ? "ok" : "failed"}: ${i.content.slice(0, 300)}]`;
    })
    .join("\n");
}

function fieldSchema(f: AgentConfig["analysis"]["fields"][number]) {
  const description = f.description || f.name;
  switch (f.type) {
    case "boolean":
      return { type: ["boolean", "null"], description };
    case "number":
      return { type: ["number", "null"], description };
    case "enum":
      return { type: ["string", "null"], enum: [...(f.choices ?? []), null], description };
    default:
      return { type: ["string", "null"], description };
  }
}

/** Builds the strict JSON schema for one structured-output call: presets + the agent's custom fields. */
export function analysisSchema(config: AgentConfig) {
  const custom = Object.fromEntries(config.analysis.fields.map((f) => [f.name, fieldSchema(f)]));
  return {
    type: "object",
    additionalProperties: false,
    required: ["call_summary", "call_successful", "user_sentiment", "custom_analysis_data"],
    properties: {
      call_summary: { type: "string", description: "2-3 sentence summary of the call" },
      call_successful: { type: "boolean", description: "Did the agent accomplish the goal of the call?" },
      user_sentiment: { type: "string", enum: ["Positive", "Neutral", "Negative", "Unknown"] },
      custom_analysis_data: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(custom),
        properties: custom,
      },
    },
  };
}

export function openaiAnalyzer(apiKey: string): Analyzer {
  const client = new OpenAI({ apiKey });
  return {
    async analyze(transcript, config) {
      const spoken = transcript.filter((t) => t.role === "user" || t.role === "agent");
      if (!spoken.length) return null;
      const res = await client.chat.completions.create({
        model: config.analysis.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You analyse phone/voice calls between an AI agent and a user. Use only the transcript. " +
              "Use null for custom fields the transcript does not answer.\n\nThe agent's instructions were:\n" +
              config.engine.prompt.slice(0, 4000),
          },
          { role: "user", content: transcriptText(transcript) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "call_analysis", strict: true, schema: analysisSchema(config) } },
      });
      const text = res.choices[0]?.message?.content;
      return text ? (JSON.parse(text) as CallAnalysis) : null;
    },
  };
}
