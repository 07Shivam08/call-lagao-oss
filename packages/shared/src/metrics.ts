import type { CallCost, Distribution, ProductCost, UsageReport } from "./call.js";

export function distribution(values: number[]): Distribution | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const pct = (p: number) => {
    // linear interpolation between closest ranks
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return Math.round((v[lo]! + (v[hi]! - v[lo]!) * (idx - lo)) * 10) / 10;
  };
  return { p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), min: v[0]!, max: v[v.length - 1]!, num: v.length, values };
}

/** Prices in US cents. Per-second items are billed on call duration. */
export const PRICING = {
  /** Your own platform margin per second, if you resell calls. 0 for self-hosting. */
  platform_per_second: 0,
  stt_per_second: { deepgram: 0.0128 } as Record<string, number>, // $0.0077/min
  tts_per_second: { elevenlabs: 0.06, cartesia: 0.05, openai: 0.025 } as Record<string, number>,
  llm_per_1k_tokens: {
    "gpt-4.1-mini": { input: 0.04, output: 0.16 },
    "gpt-4.1": { input: 0.2, output: 0.8 },
    "gpt-4o-mini": { input: 0.015, output: 0.06 },
    "gpt-4o": { input: 0.25, output: 1.0 },
  } as Record<string, { input: number; output: number }>,
  analysis_per_call: 1.0,
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function computeCost(durationMs: number, usage: UsageReport | null, stt = "deepgram", tts = "elevenlabs", analysis = true): CallCost {
  const seconds = Math.max(0, Math.ceil(durationMs / 1000));
  const items: ProductCost[] = [];
  const perSecond = (product: string, price: number) =>
    items.push({ product, unit: "second", quantity: seconds, unit_price: price, cost: round(seconds * price) });

  perSecond("call_lagao_platform", PRICING.platform_per_second);
  perSecond(`${stt}_stt`, PRICING.stt_per_second[stt] ?? 0.0128);
  perSecond(`${tts}_tts`, PRICING.tts_per_second[tts] ?? 0.06);

  if (usage && (usage.llm_prompt_tokens || usage.llm_completion_tokens)) {
    const model = usage.llm_model ?? "gpt-4.1-mini";
    const p = PRICING.llm_per_1k_tokens[model] ?? PRICING.llm_per_1k_tokens["gpt-4.1-mini"]!;
    const cost = (usage.llm_prompt_tokens / 1000) * p.input + (usage.llm_completion_tokens / 1000) * p.output;
    items.push({
      product: `llm_${model}`,
      unit: "1k_tokens",
      quantity: round((usage.llm_prompt_tokens + usage.llm_completion_tokens) / 1000),
      unit_price: p.input,
      cost: round(cost),
    });
  }
  if (analysis && seconds > 0) {
    items.push({ product: "post_call_analysis", unit: "call", quantity: 1, unit_price: PRICING.analysis_per_call, cost: PRICING.analysis_per_call });
  }
  return { combined_cost: round(items.reduce((s, i) => s + i.cost, 0)), product_costs: items, total_duration_seconds: seconds };
}
