import { SIGNATURE_HEADER, verifyWebhook } from "@call-lagao/shared/webhook";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db.js";
import type { Env } from "../src/env.js";
import type { Analyzer } from "../src/services/analysis.js";
import type { VoiceGateway } from "../src/services/voice.js";

const SECRET = "test-internal-secret";

const env: Env = {
  port: 0,
  apiBaseUrl: "http://localhost",
  webOrigin: "http://localhost:3000",
  databaseUrl: "",
  dataDir: "memory",
  internalSecret: SECRET,
  production: false,
  cookieSecure: false,
  allowSignup: "true",
  allowPrivateUrls: false,
  livekit: { url: "wss://fake.livekit", apiKey: "k", apiSecret: "s", agentName: "call-lagao-agent", sipOutboundTrunkId: "" },
  openaiApiKey: "",
};

const voiceCalls: string[] = [];
const fakeVoice: VoiceGateway = {
  configured: true,
  sipConfigured: false,
  async startWebCall(callId) {
    voiceCalls.push(`web:${callId}`);
    return { accessToken: `token-for-${callId}`, livekitUrl: env.livekit.url };
  },
  async startPhoneCall() {
    throw new Error("not used");
  },
  async endCall(callId) {
    voiceCalls.push(`end:${callId}`);
  },
};

const fakeAnalyzer: Analyzer = {
  async analyze(transcript) {
    return { call_summary: `${transcript.length} items`, call_successful: true, user_sentiment: "Positive", custom_analysis_data: { order_id: "A-17" } };
  },
};

type Delivery = { url: string; body: any; signature: string };
const deliveries: Delivery[] = [];
let pending: Promise<unknown>[] = [];
const drain = async () => {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.allSettled(batch);
  }
};

let app: FastifyInstance;
let db: Db;
let cookie = "";
let webhookSecret = "";

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, ...headers } });

beforeAll(async () => {
  db = await openDb("", "memory");
  app = await buildApp({
    db,
    env,
    voice: fakeVoice,
    analyzer: fakeAnalyzer,
    webhooks: {
      backoffMs: [0],
      fetch: async (url, init) => {
        deliveries.push({ url, body: JSON.parse(init.body), signature: init.headers[SIGNATURE_HEADER]! });
        return { status: 200 };
      },
    },
    background: (p) => pending.push(p),
  });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("auth", () => {
  it("rejects unauthenticated requests", async () => {
    const r = await call("GET", "/v1/agents");
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("signs up, sets an HttpOnly cookie, and returns the session", async () => {
    const r = await call("POST", "/v1/auth/signup", { email: "Owner@Example.com", password: "correct horse", name: "Owner", org_name: "Acme" });
    expect(r.statusCode).toBe(201);
    const setCookie = String(r.headers["set-cookie"]);
    expect(setCookie).toMatch(/cl_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    cookie = setCookie.split(";")[0]!;
    const s = await call("GET", "/v1/session");
    expect(s.json().user.email).toBe("owner@example.com");
    expect(s.json().org.name).toBe("Acme");
  });

  it("refuses duplicate emails and wrong passwords", async () => {
    expect((await call("POST", "/v1/auth/signup", { email: "owner@example.com", password: "another pass" })).statusCode).toBe(409);
    expect((await call("POST", "/v1/auth/login", { email: "owner@example.com", password: "nope nope" })).statusCode).toBe(401);
    expect((await call("POST", "/v1/auth/login", { email: "owner@example.com", password: "correct horse" })).statusCode).toBe(200);
  });

  it("creates hashed API keys that authenticate, and revokes them", async () => {
    const created = await call("POST", "/v1/api-keys", { name: "server" });
    expect(created.statusCode).toBe(201);
    const key = created.json().api_key as string;
    expect(key).toMatch(/^cl_live_/);
    const rows = await db.query(`select key_hash from api_keys`);
    expect(JSON.stringify(rows)).not.toContain(key); // plaintext never stored

    const viaKey = await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${key}` } });
    expect(viaKey.statusCode).toBe(200);

    const list = await call("GET", "/v1/api-keys");
    expect(list.json().items[0]).not.toHaveProperty("api_key");

    await call("DELETE", `/v1/api-keys/${created.json().key_id}`);
    const revoked = await app.inject({ method: "GET", url: "/v1/agents", headers: { authorization: `Bearer ${key}` } });
    expect(revoked.statusCode).toBe(401);
  });

  it("configures the org webhook and rotates its secret", async () => {
    const r = await call("PATCH", "/v1/org", { webhook_url: "https://hooks.example.com/call-lagao" });
    expect(r.json().webhook_url).toBe("https://hooks.example.com/call-lagao");
    webhookSecret = (await call("POST", "/v1/org/webhook-secret")).json().webhook_secret;
    expect(webhookSecret).toMatch(/^whsec_/);
  });
});

let agentId = "";

describe("agents & versions", () => {
  it("creates an agent with default config", async () => {
    const r = await call("POST", "/v1/agents", { name: "Support bot" });
    expect(r.statusCode).toBe(201);
    agentId = r.json().agent_id;
    expect(r.json().version).toBe(1);
    expect(r.json().is_published).toBe(false);
    expect(r.json().config.engine.model).toBe("gpt-4.1-mini");
  });

  it("validates config on save", async () => {
    const bad = await call("PATCH", `/v1/agents/${agentId}`, { config: { turn: { responsiveness: 7 } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_request");
  });

  it("edits the draft in place, publishes, then forks a new draft on the next edit", async () => {
    const edit = await call("PATCH", `/v1/agents/${agentId}`, { config: { engine: { prompt: "Help {{customer_name}} with orders." } } });
    expect(edit.json().version).toBe(1);
    expect(edit.json().config.engine.prompt).toContain("{{customer_name}}");

    const pub = await call("POST", `/v1/agents/${agentId}/publish`, { title: "v1 launch" });
    expect(pub.json().is_published).toBe(true);
    expect(pub.json().published_version).toBe(1);
    expect((await call("POST", `/v1/agents/${agentId}/publish`, {})).statusCode).toBe(409);

    const fork = await call("PATCH", `/v1/agents/${agentId}`, { config: { engine: { prompt: "Draft two" } } });
    expect(fork.json().version).toBe(2);
    expect(fork.json().base_version).toBe(1);
    expect(fork.json().published_version).toBe(1);

    const v1 = await call("GET", `/v1/agents/${agentId}?version=1`);
    expect(v1.json().config.engine.prompt).toBe("Help {{customer_name}} with orders.");

    const versions = await call("GET", `/v1/agents/${agentId}/versions`);
    expect(versions.json().items.map((v: any) => [v.version, v.is_published])).toEqual([
      [2, false],
      [1, true],
    ]);

    const list = await call("GET", "/v1/agents");
    expect(list.json().items[0]).toMatchObject({ agent_id: agentId, latest_version: 2, published_version: 1 });
  });
});

describe("web call lifecycle", () => {
  let callId = "";

  it("creates a web call on the published version and mints a token", async () => {
    const r = await call("POST", "/v1/calls/web", { agent_id: agentId, dynamic_variables: { customer_name: "Asha" }, metadata: { ticket: 9 } });
    expect(r.statusCode).toBe(201);
    callId = r.json().call_id;
    expect(callId).toMatch(/^call_/);
    expect(r.json().access_token).toBe(`token-for-${callId}`);
    expect(r.json().call).toMatchObject({ call_status: "registered", agent_version: 1, call_type: "web_call" });
    expect(voiceCalls).toContain(`web:${callId}`);
  });

  it("serves the worker context only with the internal secret", async () => {
    expect((await app.inject({ method: "GET", url: `/internal/calls/${callId}/context` })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: `/internal/calls/${callId}/context`, headers: { "x-internal-secret": SECRET } });
    expect(r.statusCode).toBe(200);
    expect(r.json().agent_config.engine.prompt).toBe("Help {{customer_name}} with orders.");
    expect(r.json().dynamic_variables).toEqual({ customer_name: "Asha" });
    expect(r.json().agent_name).toBe("Support bot");
  });

  it("goes ongoing on started and fires a signed call_started webhook", async () => {
    const started = Date.now() - 30_000;
    const r = await app.inject({ method: "POST", url: `/internal/calls/${callId}/started`, headers: { "x-internal-secret": SECRET }, payload: { started_at: started } });
    expect(r.json()).toEqual({ ok: true, applied: true });
    await drain();
    const d = deliveries.find((x) => x.body.event === "call_started")!;
    expect(d.url).toBe("https://hooks.example.com/call-lagao");
    expect(d.body.call.call_status).toBe("ongoing");
    expect(verifyWebhook(JSON.stringify(d.body), webhookSecret, d.signature)).toBe(true);
  });

  it("ends once, computes latency + cost, runs analysis, fires call_ended then call_analyzed", async () => {
    const report = {
      ended_at: Date.now(),
      disconnection_reason: "agent_hangup",
      transcript: [
        { role: "agent", content: "Hi Asha!", start_ms: 0, end_ms: 900 },
        { role: "user", content: "Where is my order?", start_ms: 1500, end_ms: 2600 },
        { role: "tool_call_invocation", tool_call_id: "t1", name: "lookup_order", arguments: "{}", time_ms: 3000 },
        { role: "tool_call_result", tool_call_id: "t1", content: "{\"status\":\"shipped\"}", successful: true, time_ms: 3300 },
        { role: "agent", content: "It shipped yesterday.", start_ms: 3500, end_ms: 5000 },
      ],
      collected_variables: { order_id: "A-17" },
      latency: { e2e: [800, 900, 1000], stt: [250, 260], llm: [400, 450], tts: [120, 130] },
      usage: { llm_model: "gpt-4.1-mini", llm_prompt_tokens: 1200, llm_completion_tokens: 80, llm_requests: 2, tts_provider: "elevenlabs", tts_characters: 40, stt_audio_seconds: 12 },
    };
    const send = () => app.inject({ method: "POST", url: `/internal/calls/${callId}/ended`, headers: { "x-internal-secret": SECRET }, payload: report });
    expect((await send()).json().applied).toBe(true);
    expect((await send()).json().applied).toBe(false); // idempotent
    await drain();

    const c = (await call("GET", `/v1/calls/${callId}`)).json();
    expect(c.call_status).toBe("ended");
    expect(c.disconnection_reason).toBe("agent_hangup");
    expect(c.duration_ms).toBeGreaterThanOrEqual(29_000);
    expect(c.latency.e2e.p50).toBe(900);
    expect(c.latency.llm.num).toBe(2);
    expect(c.call_cost.total_duration_seconds).toBeGreaterThanOrEqual(29);
    expect(c.call_cost.product_costs.map((p: any) => p.product)).toContain("post_call_analysis");
    expect(c.call_analysis.custom_analysis_data.order_id).toBe("A-17");
    expect(c.transcript).toHaveLength(5);

    const events = deliveries.filter((x) => x.body.call.call_id === callId).map((x) => x.body.event);
    expect(events).toEqual(["call_started", "call_ended", "call_analyzed"]);
    expect(deliveries.find((x) => x.body.event === "call_analyzed")!.body.call.call_analysis.call_successful).toBe(true);
    const logged = await db.query(`select count(*)::int as n from webhook_deliveries where call_id = $1`, [callId]);
    expect(logged[0]!.n).toBe(3);
  });

  it("lists calls newest first with cursor pagination and filters", async () => {
    const second = await call("POST", "/v1/calls/web", { agent_id: agentId, agent_version: 2 });
    expect(second.json().call.agent_version).toBe(2);
    const page1 = (await call("GET", "/v1/calls?limit=1")).json();
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].call_id).toBe(second.json().call_id);
    expect(page1.has_more).toBe(true);
    const page2 = (await call("GET", `/v1/calls?limit=1&pagination_key=${page1.pagination_key}`)).json();
    expect(page2.items[0].call_id).toBe(callId);
    const ended = (await call("GET", "/v1/calls?status=ended")).json();
    expect(ended.items.every((x: any) => x.call_status === "ended")).toBe(true);
  });

  it("stopping a call that never connected closes it as not_connected", async () => {
    const r = (await call("POST", "/v1/calls/web", { agent_id: agentId })).json();
    expect((await call("POST", `/v1/calls/${r.call_id}/stop`)).statusCode).toBe(200);
    await drain();
    const c = (await call("GET", `/v1/calls/${r.call_id}`)).json();
    expect(c.call_status).toBe("not_connected");
    expect(c.disconnection_reason).toBe("manual_stopped");
    expect(voiceCalls).toContain(`end:${r.call_id}`);
  });

  it("enforces the org concurrency limit", async () => {
    await db.query(`update organizations set concurrency_limit = 1`);
    // one call from the pagination test is still registered
    const r = await call("POST", "/v1/calls/web", { agent_id: agentId });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("concurrency_limit_reached");
  });

  it("returns 501 for phone calls without a SIP trunk", async () => {
    const r = await call("POST", "/v1/calls/phone", { agent_id: agentId, from_number: "+14155550100", to_number: "+916200000000" });
    expect(r.statusCode).toBe(501);
  });
});

describe("tenancy", () => {
  it("never shows another org's agents or calls", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/auth/signup", payload: { email: "intruder@example.com", password: "password123" } });
    const otherCookie = String(other.headers["set-cookie"]).split(";")[0]!;
    const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: otherCookie } });
    expect((await get(`/v1/agents/${agentId}`)).statusCode).toBe(404);
    expect((await get("/v1/calls")).json().items).toHaveLength(0);
    const r = await app.inject({ method: "POST", url: "/v1/calls/web", headers: { cookie: otherCookie }, payload: { agent_id: agentId } });
    expect(r.statusCode).toBe(404);
  });
});

describe("security", () => {
  it("cannot reach /internal or /v1 by percent-encoding the path", async () => {
    for (const url of ["/%69nternal/calls/call_x/context", "/%761/agents", "/v%31/calls"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it("closes sign-up after the first account by default", async () => {
    const db2 = await openDb("", "memory");
    const app2 = await buildApp({ db: db2, env: { ...env, allowSignup: "first" }, voice: fakeVoice, analyzer: fakeAnalyzer, webhooks: {}, background: () => {} });
    const signup = (email: string) => app2.inject({ method: "POST", url: "/v1/auth/signup", payload: { email, password: "password123" } });
    expect((await signup("first@example.com")).statusCode).toBe(201);
    const r = await signup("second@example.com");
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("signup_disabled");
    await app2.close();
    await db2.close();
  });

  it("refuses webhooks to private addresses", async () => {
    const { assertPublicUrl, isPublicIp } = await import("../src/netguard.js");
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.10", "::1", "::ffff:127.0.0.1", "fd00::1", "100.64.1.1"]) expect(isPublicIp(ip), ip).toBe(false);
    expect(isPublicIp("8.8.8.8")).toBe(true);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:8080/hook")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
  });
});
