import { describe, expect, it } from "vitest";
import { AgentConfig, CallEndedReport, computeCost, distribution, newId, renderTemplate } from "./index.js";
import { signWebhook, verifyWebhook } from "./webhook.js";

describe("ids", () => {
  it("prefixes and sorts by time", () => {
    const a = newId("agent");
    expect(a).toMatch(/^agent_[0-9a-z]{26}$/);
  });
});

describe("AgentConfig", () => {
  it("fills every default from an empty object", () => {
    const c = AgentConfig.parse({});
    expect(c.engine.model).toBe("gpt-4.1-mini");
    expect(c.engine.tools[0]?.type).toBe("end_call");
    expect(c.voice.provider).toBe("elevenlabs");
    expect(c.turn.interruption_sensitivity).toBe(0.8);
  });

  it("validates custom tools", () => {
    const ok = AgentConfig.safeParse({
      engine: { tools: [{ type: "custom", name: "lookup_order", description: "x", url: "https://example.com/hook" }] },
    });
    expect(ok.success).toBe(true);
    const bad = AgentConfig.safeParse({ engine: { tools: [{ type: "custom", name: "bad name", description: "x", url: "nope" }] } });
    expect(bad.success).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("substitutes known variables and keeps unknown ones", () => {
    expect(renderTemplate("Hi {{name}}, re {{ topic }} {{missing}}", { name: "Asha", topic: "loan" })).toBe("Hi Asha, re loan {{missing}}");
  });
});

describe("distribution", () => {
  it("computes percentiles", () => {
    const d = distribution([100, 200, 300, 400, 500])!;
    expect(d.p50).toBe(300);
    expect(d.min).toBe(100);
    expect(d.max).toBe(500);
    expect(d.num).toBe(5);
  });
  it("returns undefined for no samples", () => {
    expect(distribution([])).toBeUndefined();
  });
});

describe("computeCost", () => {
  it("bills per second plus tokens plus analysis", () => {
    const c = computeCost(24_500, { llm_model: "gpt-4.1-mini", llm_prompt_tokens: 2000, llm_completion_tokens: 500, llm_requests: 4, tts_characters: 0, stt_audio_seconds: 0 });
    expect(c.total_duration_seconds).toBe(25);
    expect(c.product_costs.map((p) => p.product)).toEqual([
      "call_lagao_platform",
      "deepgram_stt",
      "elevenlabs_tts",
      "llm_gpt-4.1-mini",
      "post_call_analysis",
    ]);
    expect(c.combined_cost).toBeGreaterThan(0);
  });
});

describe("CallEndedReport", () => {
  it("accepts a minimal report", () => {
    const r = CallEndedReport.parse({ ended_at: Date.now(), disconnection_reason: "user_hangup" });
    expect(r.transcript).toEqual([]);
    expect(r.latency.e2e).toEqual([]);
  });
});

describe("webhook signatures", () => {
  it("round-trips and rejects tampering or stale timestamps", () => {
    const body = JSON.stringify({ event: "call_ended" });
    const sig = signWebhook(body, "s3cret");
    expect(verifyWebhook(body, "s3cret", sig)).toBe(true);
    expect(verifyWebhook(body + " ", "s3cret", sig)).toBe(false);
    expect(verifyWebhook(body, "other", sig)).toBe(false);
    const old = signWebhook(body, "s3cret", Date.now() - 10 * 60_000);
    expect(verifyWebhook(body, "s3cret", old)).toBe(false);
  });
});
