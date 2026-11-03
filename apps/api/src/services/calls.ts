import { AgentConfig, computeCost, distribution, type CallEndedReport, type Distribution, type LatencySamples } from "@call-lagao/shared";
import type { Db } from "../db.js";
import { toCall } from "../serialize.js";
import type { Analyzer } from "./analysis.js";
import { sendWebhooks, type WebhookOptions } from "./webhooks.js";

export type LifecycleDeps = { db: Db; analyzer: Analyzer; webhooks: WebhookOptions; background: (p: Promise<unknown>) => void };

/** A call that never got a participant within this window is marked not_connected. */
export const REGISTERED_TIMEOUT_MS = 3 * 60_000;
/** Safety net for calls whose worker died without reporting. */
export const ONGOING_TIMEOUT_MS = 3 * 60 * 60_000;

async function loadCallWithConfig(db: Db, callId: string) {
  const [row] = await db.query(
    `select c.*, a.name as agent_name, v.config as agent_config
       from calls c join agents a on a.id = c.agent_id
       join agent_versions v on v.agent_id = c.agent_id and v.version = c.agent_version
      where c.id = $1`,
    [callId],
  );
  return row;
}

export async function markStarted(deps: LifecycleDeps, callId: string, startedAt: number): Promise<boolean> {
  const updated = await deps.db.query(
    `update calls set status = 'ongoing', started_at = $2 where id = $1 and status = 'registered' returning id`,
    [callId, new Date(startedAt)],
  );
  if (!updated.length) return false;
  const row = await loadCallWithConfig(deps.db, callId);
  const cfg = AgentConfig.parse(row.agent_config ?? {});
  deps.background(sendWebhooks(deps.db, row.org_id, "call_started", toCall(row), cfg.webhook_url, deps.webhooks));
  return true;
}

export function latencyDistributions(samples: LatencySamples): Partial<Record<keyof LatencySamples, Distribution>> {
  const out: Partial<Record<keyof LatencySamples, Distribution>> = {};
  for (const k of ["e2e", "stt", "llm", "tts"] as const) {
    const d = distribution(samples[k] ?? []);
    if (d) out[k] = d;
  }
  return out;
}

/** Idempotent: only the first `ended` report for a call is applied. */
export async function markEnded(deps: LifecycleDeps, callId: string, report: CallEndedReport): Promise<boolean> {
  const { db } = deps;
  const current = await loadCallWithConfig(db, callId);
  if (!current || current.status === "ended" || current.status === "error" || current.status === "not_connected") return false;

  const cfg = AgentConfig.parse(current.agent_config ?? {});
  const startedAt = current.started_at ? new Date(current.started_at).getTime() : null;
  const durationMs = startedAt ? Math.max(0, report.ended_at - startedAt) : 0;
  const neverConnected = !startedAt;
  const status = report.disconnection_reason.startsWith("error_") ? "error" : neverConnected ? "not_connected" : "ended";
  const cost = computeCost(durationMs, report.usage, cfg.stt.provider, report.usage.tts_provider ?? cfg.voice.provider, !neverConnected);

  const updated = await db.query(
    `update calls set status = $2, disconnection_reason = $3, ended_at = $4, duration_ms = $5, transcript = $6,
            collected_variables = $7, latency = $8, usage = $9, cost = $10, error_message = $11
      where id = $1 and status in ('registered', 'ongoing') returning id`,
    [
      callId,
      status,
      report.disconnection_reason,
      new Date(report.ended_at),
      durationMs,
      JSON.stringify(report.transcript),
      JSON.stringify(report.collected_variables),
      JSON.stringify(latencyDistributions(report.latency)),
      JSON.stringify(report.usage),
      JSON.stringify(cost),
      report.error_message ?? null,
    ],
  );
  if (!updated.length) return false; // lost a race with another ended report

  deps.background(postCall(deps, callId, cfg));
  return true;
}

/** call_ended webhook → analysis → call_analyzed webhook. */
async function postCall(deps: LifecycleDeps, callId: string, cfg: AgentConfig) {
  const { db } = deps;
  let row = await loadCallWithConfig(db, callId);
  await sendWebhooks(db, row.org_id, "call_ended", toCall(row), cfg.webhook_url, deps.webhooks);

  if (row.status === "not_connected") return;
  let analysis = null;
  try {
    analysis = await deps.analyzer.analyze(toCall(row).transcript, cfg);
  } catch (e) {
    console.error(`[post-call] analysis failed for ${callId}:`, (e as Error)?.message ?? e);
  }
  if (analysis) {
    await db.query(`update calls set analysis = $2 where id = $1`, [callId, JSON.stringify(analysis)]);
  } else {
    // no analyzer configured or nothing to analyse → don't bill for it
    const cost = row.cost && typeof row.cost === "object" ? row.cost : null;
    if (cost?.product_costs?.some((p: { product: string }) => p.product === "post_call_analysis")) {
      const items = cost.product_costs.filter((p: { product: string }) => p.product !== "post_call_analysis");
      const combined = Math.round(items.reduce((s: number, p: { cost: number }) => s + p.cost, 0) * 1e6) / 1e6;
      await db.query(`update calls set cost = $2 where id = $1`, [callId, JSON.stringify({ ...cost, product_costs: items, combined_cost: combined })]);
    }
  }
  row = await loadCallWithConfig(db, callId);
  await sendWebhooks(db, row.org_id, "call_analyzed", toCall(row), cfg.webhook_url, deps.webhooks);
}

/** Close out calls that will never get a worker report. Cheap enough to run on each list/create. */
export async function reapStaleCalls(db: Db, orgId: string) {
  await db.query(
    `update calls set status = 'not_connected', disconnection_reason = coalesce(disconnection_reason, 'error_worker'), ended_at = now()
      where org_id = $1 and status = 'registered' and created_at < now() - ($2 || ' milliseconds')::interval`,
    [orgId, String(REGISTERED_TIMEOUT_MS)],
  );
  await db.query(
    `update calls set status = 'error', disconnection_reason = 'error_worker', ended_at = now(),
            duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int
      where org_id = $1 and status = 'ongoing' and started_at < now() - ($2 || ' milliseconds')::interval`,
    [orgId, String(ONGOING_TIMEOUT_MS)],
  );
}
