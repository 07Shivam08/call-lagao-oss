import { AgentConfig, CallEndedReport, CallStartedReport, newId, type CallContext } from "@call-lagao/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { lifecycle, type Deps } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { toCall } from "../serialize.js";
import { markEnded, markStarted, reapStaleCalls } from "../services/calls.js";
import { getAgentRow, getVersionRow } from "./agents.js";

const vars = z.record(z.string(), z.coerce.string()).default({});
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +14155550123");

const WebCall = z.object({
  agent_id: z.string(),
  agent_version: z.number().int().min(1).optional(),
  dynamic_variables: vars,
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const PhoneCall = WebCall.extend({ from_number: e164, to_number: e164 });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  pagination_key: z.string().optional(),
  agent_id: z.string().optional(),
  status: z.enum(["registered", "ongoing", "ended", "not_connected", "error"]).optional(),
});

type P = { Params: { callId: string } };

async function reserveCall(db: Db, orgId: string, body: z.infer<typeof WebCall>, extra: { call_type: string; direction: string | null; from: string | null; to: string | null }) {
  const agent = await getAgentRow(db, orgId, body.agent_id);
  const version = body.agent_version ?? agent.published_version ?? agent.latest_version;
  await getVersionRow(db, agent.id, version); // 404 if it doesn't exist
  await reapStaleCalls(db, orgId);

  const callId = newId("call");
  await db.tx(async (t) => {
    // serialise concurrent creates per org so the limit check is accurate
    await t.query(`select id from organizations where id = $1 for update`, [orgId]);
    const [{ active, lim: limit }] = (await t.query(
      `select (select count(*)::int from calls where org_id = $1 and status in ('registered','ongoing')) as active,
              (select concurrency_limit from organizations where id = $1) as lim`,
      [orgId],
    )) as [{ active: number; lim: number }];
    if (active >= limit) throw new ApiError(429, "concurrency_limit_reached", `Concurrency limit of ${limit} active calls reached`);
    await t.query(
      `insert into calls (id, org_id, agent_id, agent_version, call_type, direction, from_number, to_number, dynamic_variables, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [callId, orgId, agent.id, version, extra.call_type, extra.direction, extra.from, extra.to, JSON.stringify(body.dynamic_variables), JSON.stringify(body.metadata)],
    );
  });
  return { callId, agentName: agent.name as string };
}

async function failCall(db: Db, callId: string, message: string) {
  await db.query(`update calls set status = 'error', disconnection_reason = 'error_unknown', error_message = $2, ended_at = now() where id = $1`, [callId, message.slice(0, 500)]);
}

async function getCallRow(db: Db, orgId: string, callId: string) {
  const [row] = await db.query(`select c.*, a.name as agent_name from calls c join agents a on a.id = c.agent_id where c.id = $1 and c.org_id = $2`, [callId, orgId]);
  if (!row) throw notFound("Call");
  return row;
}

export function callRoutes(app: FastifyInstance, d: Deps) {
  const { db, voice } = d;

  app.post("/v1/calls/web", async (req, reply) => {
    if (!voice.configured) throw new ApiError(503, "voice_not_configured", "LiveKit is not configured on the server (set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)");
    const body = WebCall.parse(req.body);
    const orgId = req.auth!.orgId;
    const { callId } = await reserveCall(db, orgId, body, { call_type: "web_call", direction: null, from: null, to: null });
    try {
      const { accessToken, livekitUrl } = await voice.startWebCall(callId);
      return reply.status(201).send({ call_id: callId, access_token: accessToken, livekit_url: livekitUrl, call: toCall(await getCallRow(db, orgId, callId)) });
    } catch (e) {
      req.log.error(e, "starting web call failed");
      await failCall(db, callId, String((e as Error)?.message ?? e));
      throw new ApiError(502, "voice_unavailable", "Could not start the call. Check the API logs and your LiveKit configuration.");
    }
  });

  app.post("/v1/calls/phone", async (req, reply) => {
    if (!voice.sipConfigured) throw new ApiError(501, "not_configured", "Phone calls need LIVEKIT_SIP_OUTBOUND_TRUNK_ID (a LiveKit outbound SIP trunk)");
    const body = PhoneCall.parse(req.body);
    const orgId = req.auth!.orgId;
    const { callId } = await reserveCall(db, orgId, body, { call_type: "phone_call", direction: "outbound", from: body.from_number, to: body.to_number });
    try {
      await voice.startPhoneCall(callId, body.from_number, body.to_number);
      return reply.status(201).send({ call_id: callId, call: toCall(await getCallRow(db, orgId, callId)) });
    } catch (e) {
      req.log.error(e, "placing phone call failed");
      await failCall(db, callId, String((e as Error)?.message ?? e));
      throw new ApiError(502, "dial_failed", "Could not place the call. Check the API logs and your SIP trunk configuration.");
    }
  });

  app.get("/v1/calls", async (req) => {
    const q = ListQuery.parse(req.query);
    const orgId = req.auth!.orgId;
    await reapStaleCalls(db, orgId);
    const params: unknown[] = [orgId];
    let where = `c.org_id = $1`;
    if (q.pagination_key) where += ` and c.id < $${params.push(q.pagination_key)}`;
    if (q.agent_id) where += ` and c.agent_id = $${params.push(q.agent_id)}`;
    if (q.status) where += ` and c.status = $${params.push(q.status)}`;
    const rows = await db.query(
      `select c.*, a.name as agent_name from calls c join agents a on a.id = c.agent_id where ${where} order by c.id desc limit ${q.limit + 1}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map((r) => toCall(r));
    return { items, has_more: hasMore, pagination_key: hasMore ? items[items.length - 1]!.call_id : null };
  });

  app.get<P>("/v1/calls/:callId", async (req) => toCall(await getCallRow(db, req.auth!.orgId, req.params.callId)));

  app.post<P>("/v1/calls/:callId/stop", async (req) => {
    const row = await getCallRow(db, req.auth!.orgId, req.params.callId);
    if (row.status !== "registered" && row.status !== "ongoing") throw new ApiError(409, "call_not_active", "Call is not active");
    if (voice.configured) await voice.endCall(row.id);
    // The worker reports `manual_stopped`; if no worker ever joined, close it here.
    if (row.status === "registered") {
      await markEnded(lifecycle(d), row.id, CallEndedReport.parse({ ended_at: Date.now(), disconnection_reason: "manual_stopped" }));
    }
    return { ok: true };
  });
}

export function internalRoutes(app: FastifyInstance, d: Deps) {
  const { db } = d;

  app.get<P>("/internal/calls/:callId/context", async (req): Promise<CallContext> => {
    const [row] = await db.query(
      `select c.*, a.name as agent_name, v.config from calls c
         join agents a on a.id = c.agent_id
         join agent_versions v on v.agent_id = c.agent_id and v.version = c.agent_version
        where c.id = $1`,
      [req.params.callId],
    );
    if (!row) throw notFound("Call");
    const call = toCall(row);
    return {
      call: {
        call_id: call.call_id,
        call_type: call.call_type,
        direction: call.direction,
        agent_id: call.agent_id,
        agent_version: call.agent_version,
        from_number: call.from_number,
        to_number: call.to_number,
        metadata: call.metadata,
      },
      agent_name: row.agent_name,
      agent_config: AgentConfig.parse(row.config ?? {}),
      dynamic_variables: call.dynamic_variables,
    };
  });

  app.post<P>("/internal/calls/:callId/started", async (req) => {
    const body = CallStartedReport.parse(req.body);
    const [row] = await db.query(`select id from calls where id = $1`, [req.params.callId]);
    if (!row) throw notFound("Call");
    const applied = await markStarted(lifecycle(d), req.params.callId, body.started_at);
    return { ok: true, applied };
  });

  app.post<P>("/internal/calls/:callId/ended", async (req) => {
    const body = CallEndedReport.parse(req.body);
    const [row] = await db.query(`select id from calls where id = $1`, [req.params.callId]);
    if (!row) throw notFound("Call");
    const applied = await markEnded(lifecycle(d), req.params.callId, body);
    return { ok: true, applied };
  });
}
