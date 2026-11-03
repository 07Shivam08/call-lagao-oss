import { AgentConfig, type Call } from "@call-lagao/shared";
import type { Row } from "./db.js";

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** pg returns jsonb already parsed; PGlite does too. Guard against strings anyway. */
const json = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

export function toCall(r: Row, agentName: string | null = r.agent_name ?? null): Call {
  return {
    call_id: r.id,
    call_type: r.call_type,
    direction: r.direction ?? null,
    agent_id: r.agent_id,
    agent_version: r.agent_version,
    agent_name: agentName,
    call_status: r.status,
    from_number: r.from_number ?? null,
    to_number: r.to_number ?? null,
    start_timestamp: ms(r.started_at),
    end_timestamp: ms(r.ended_at),
    duration_ms: r.duration_ms ?? null,
    disconnection_reason: r.disconnection_reason ?? null,
    dynamic_variables: json(r.dynamic_variables, {}),
    collected_variables: json(r.collected_variables, {}),
    metadata: json(r.metadata, {}),
    transcript: json(r.transcript, []),
    latency: json(r.latency, {}),
    usage: json(r.usage, null),
    call_cost: json(r.cost, null),
    call_analysis: json(r.analysis, null),
    recording_url: r.recording_url ?? null,
    created_timestamp: ms(r.created_at)!,
  };
}

export function toAgent(agent: Row, version: Row) {
  return {
    agent_id: agent.id,
    name: agent.name,
    version: version.version,
    base_version: version.base_version ?? null,
    is_published: version.is_published,
    title: version.title ?? null,
    latest_version: agent.latest_version,
    published_version: agent.published_version ?? null,
    config: AgentConfig.parse(json(version.config, {})),
    created_timestamp: ms(agent.created_at),
    updated_timestamp: ms(version.updated_at),
  };
}

export function toOrg(o: Row) {
  return { org_id: o.id, name: o.name, webhook_url: o.webhook_url ?? null, concurrency_limit: o.concurrency_limit };
}

export function toUser(u: Row) {
  return { user_id: u.id, email: u.email, name: u.name ?? null };
}
