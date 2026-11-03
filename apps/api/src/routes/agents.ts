import { AgentConfig, newId } from "@call-lagao/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import type { Deps } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { toAgent } from "../serialize.js";

const Create = z.object({ name: z.string().min(1).max(120), config: AgentConfig.optional() });
const Patch = z.object({ name: z.string().min(1).max(120).optional(), config: AgentConfig.optional() });
const Publish = z.object({ title: z.string().max(200).optional() }).default({});
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

type P = { Params: { agentId: string } };

export async function getAgentRow(db: Db, orgId: string, agentId: string) {
  const [a] = await db.query(`select * from agents where id = $1 and org_id = $2 and deleted_at is null`, [agentId, orgId]);
  if (!a) throw notFound("Agent");
  return a;
}

export async function getVersionRow(db: Db, agentId: string, version: number) {
  const [v] = await db.query(`select * from agent_versions where agent_id = $1 and version = $2`, [agentId, version]);
  if (!v) throw notFound(`Agent version ${version}`);
  return v;
}

export function agentRoutes(app: FastifyInstance, { db }: Deps) {
  app.get("/v1/agents", async (req) => {
    const rows = await db.query(
      `select a.*, v.config, v.updated_at as version_updated_at
         from agents a join agent_versions v on v.agent_id = a.id and v.version = a.latest_version
        where a.org_id = $1 and a.deleted_at is null
        order by a.updated_at desc`,
      [req.auth!.orgId],
    );
    return {
      items: rows.map((r) => {
        const cfg = AgentConfig.parse(r.config ?? {});
        return {
          agent_id: r.id,
          name: r.name,
          latest_version: r.latest_version,
          published_version: r.published_version ?? null,
          updated_timestamp: new Date(r.updated_at).getTime(),
          voice_provider: cfg.voice.provider,
          model: cfg.engine.model,
        };
      }),
    };
  });

  app.post("/v1/agents", async (req, reply) => {
    const body = Create.parse(req.body);
    const id = newId("agent");
    const config = body.config ?? AgentConfig.parse({});
    await db.tx(async (t) => {
      await t.query(`insert into agents (id, org_id, name, latest_version) values ($1, $2, $3, 1)`, [id, req.auth!.orgId, body.name]);
      await t.query(`insert into agent_versions (agent_id, version, config) values ($1, 1, $2)`, [id, JSON.stringify(config)]);
    });
    const a = await getAgentRow(db, req.auth!.orgId, id);
    return reply.status(201).send(toAgent(a, await getVersionRow(db, id, 1)));
  });

  app.get<P>("/v1/agents/:agentId", async (req) => {
    const { version } = VersionQuery.parse(req.query);
    const a = await getAgentRow(db, req.auth!.orgId, req.params.agentId);
    return toAgent(a, await getVersionRow(db, a.id, version ?? a.latest_version));
  });

  app.patch<P>("/v1/agents/:agentId", async (req) => {
    const body = Patch.parse(req.body);
    const orgId = req.auth!.orgId;
    const agentId = req.params.agentId;
    await db.tx(async (t) => {
      const a = await getAgentRow(t, orgId, agentId);
      let draft = await getVersionRow(t, agentId, a.latest_version);
      if (draft.is_published) {
        // published versions are immutable → fork a new draft from it
        const next = a.latest_version + 1;
        await t.query(`insert into agent_versions (agent_id, version, base_version, config) values ($1, $2, $3, $4)`, [
          agentId,
          next,
          draft.version,
          JSON.stringify(draft.config),
        ]);
        await t.query(`update agents set latest_version = $2 where id = $1`, [agentId, next]);
        draft = await getVersionRow(t, agentId, next);
      }
      if (body.config) {
        await t.query(`update agent_versions set config = $3, updated_at = now() where agent_id = $1 and version = $2`, [
          agentId,
          draft.version,
          JSON.stringify(body.config),
        ]);
      }
      await t.query(`update agents set name = coalesce($2, name), updated_at = now() where id = $1`, [agentId, body.name ?? null]);
    });
    const a = await getAgentRow(db, orgId, agentId);
    return toAgent(a, await getVersionRow(db, agentId, a.latest_version));
  });

  app.delete<P>("/v1/agents/:agentId", async (req) => {
    const a = await getAgentRow(db, req.auth!.orgId, req.params.agentId);
    await db.query(`update agents set deleted_at = now() where id = $1`, [a.id]);
    return { ok: true };
  });

  app.get<P>("/v1/agents/:agentId/versions", async (req) => {
    const a = await getAgentRow(db, req.auth!.orgId, req.params.agentId);
    const rows = await db.query(`select * from agent_versions where agent_id = $1 order by version desc`, [a.id]);
    return {
      items: rows.map((v) => ({
        version: v.version,
        base_version: v.base_version ?? null,
        is_published: v.is_published,
        title: v.title ?? null,
        updated_timestamp: new Date(v.updated_at).getTime(),
      })),
    };
  });

  app.post<P>("/v1/agents/:agentId/publish", async (req) => {
    const body = Publish.parse(req.body ?? {});
    const orgId = req.auth!.orgId;
    const agentId = req.params.agentId;
    await db.tx(async (t) => {
      const a = await getAgentRow(t, orgId, agentId);
      const draft = await getVersionRow(t, agentId, a.latest_version);
      if (draft.is_published) throw new ApiError(409, "already_published", `Version ${draft.version} is already published; edit the agent to create a new draft`);
      await t.query(`update agent_versions set is_published = true, title = $3, updated_at = now() where agent_id = $1 and version = $2`, [
        agentId,
        draft.version,
        body.title ?? null,
      ]);
      await t.query(`update agents set published_version = $2, updated_at = now() where id = $1`, [agentId, draft.version]);
    });
    const a = await getAgentRow(db, orgId, agentId);
    return toAgent(a, await getVersionRow(db, agentId, a.latest_version));
  });
}
