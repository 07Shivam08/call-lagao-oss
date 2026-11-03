/**
 * Dev helper: pushes one simulated call through the real lifecycle (registered → started → ended → analysis)
 * so Call History has something to show before LiveKit keys are configured.
 *
 *   pnpm --filter @call-lagao/api seed:demo [email]
 *
 * Stop the API first when using the embedded PGlite database (it allows one process at a time).
 */
import { CallEndedReport, newId } from "@call-lagao/shared";
import { openDb } from "../src/db.js";
import { readEnv } from "../src/env.js";
import { markEnded, markStarted } from "../src/services/calls.js";

const env = readEnv();
const db = await openDb(env.databaseUrl, env.dataDir);
const email = process.argv[2];

const [agent] = await db.query(
  `select a.* from agents a join memberships m on m.org_id = a.org_id join users u on u.id = m.user_id
    where a.deleted_at is null ${email ? "and u.email = $1" : ""} order by a.created_at limit 1`,
  email ? [email.toLowerCase()] : [],
);
if (!agent) {
  console.error("No agent found — create one in the dashboard first.");
  process.exit(1);
}

const callId = newId("call");
await db.query(
  `insert into calls (id, org_id, agent_id, agent_version, call_type, dynamic_variables, metadata) values ($1,$2,$3,$4,'web_call',$5,$6)`,
  [callId, agent.org_id, agent.id, agent.published_version ?? agent.latest_version, JSON.stringify({ customer_name: "Asha" }), JSON.stringify({ source: "seed" })],
);

const deps = {
  db,
  webhooks: {},
  background: () => undefined,
  analyzer: {
    analyze: async () => ({
      call_summary: "Asha asked about the status of order A-17. The agent looked it up and confirmed it shipped yesterday, then ended the call politely.",
      call_successful: true,
      user_sentiment: "Positive" as const,
      custom_analysis_data: {},
    }),
  },
};

const start = Date.now() - 42_000;
await markStarted(deps, callId, start);
await markEnded(
  { ...deps, background: (p) => void p },
  callId,
  CallEndedReport.parse({
    ended_at: start + 41_500,
    disconnection_reason: "agent_hangup",
    transcript: [
      { role: "agent", content: "Hi Asha! Thanks for calling. How can I help you today?", start_ms: 300, end_ms: 3200 },
      { role: "user", content: "Hi, I wanted to check where my order A-17 is.", start_ms: 4100, end_ms: 6800 },
      { role: "agent", content: "Sure, let me look that up for you.", start_ms: 7600, end_ms: 9100 },
      { role: "tool_call_invocation", tool_call_id: "tc_1", name: "lookup_order", arguments: '{"order_id":"A-17"}', time_ms: 9200 },
      { role: "tool_call_result", tool_call_id: "tc_1", content: '{"status":"shipped","carrier":"BlueDart","eta":"tomorrow"}', successful: true, time_ms: 9650 },
      { role: "agent", content: "Good news — it shipped yesterday with BlueDart and should arrive tomorrow.", start_ms: 10100, end_ms: 14200 },
      { role: "user", content: "Perfect, thank you!", start_ms: 15000, end_ms: 16100 },
      { role: "agent", content: "You're welcome, Asha. Have a great day!", start_ms: 16900, end_ms: 19000 },
      { role: "tool_call_invocation", tool_call_id: "tc_2", name: "end_call", arguments: "{}", time_ms: 19100 },
    ],
    collected_variables: { order_id: "A-17" },
    latency: { e2e: [780, 910, 860, 1020], stt: [240, 265, 250, 270], llm: [390, 455, 410, 470], tts: [118, 131, 125, 140] },
    usage: { llm_model: "gpt-4.1-mini", llm_prompt_tokens: 3400, llm_completion_tokens: 160, llm_requests: 4, tts_provider: "elevenlabs", tts_characters: 210, stt_audio_seconds: 18 },
  }),
);
// let the background analysis finish before closing
await new Promise((r) => setTimeout(r, 500));
console.log(`Seeded ${callId} for agent ${agent.name}`);
await db.close();
