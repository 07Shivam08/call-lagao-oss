# @call-lagao/api

Fastify + TypeScript API for Call Lagao. It owns auth, organizations, API keys, versioned agents, calls, the internal worker API, post-call analysis and webhooks. Data lives in Postgres (or embedded [PGlite](https://pglite.dev) in `.data/` when `DATABASE_URL` is empty), with migrations in [`packages/db/migrations`](../../packages/db/migrations) applied automatically on start.

```bash
pnpm --filter @call-lagao/api dev        # watch mode on :4000
pnpm --filter @call-lagao/api build && pnpm --filter @call-lagao/api start
pnpm --filter @call-lagao/api test       # end-to-end tests on an in-memory PGlite
```

This file is the **service contract** between the three runtime pieces (API, voice worker, browser). Change it here first, then in code.

```
Browser (apps/web + packages/web-sdk) ──HTTP /api/v1/* (proxied)─▶ API (apps/api, Fastify, :4000)
        │                                                          │  ▲
        │ WebRTC (LiveKit room = call_id)                          │  │ HTTP /internal/* (x-internal-secret)
        ▼                                                          ▼  │
   LiveKit Cloud ◀──────────── joins room as agent ──────── Voice worker (apps/voice, Python LiveKit Agents)
```

Types referenced below live in `packages/shared/src` (`AgentConfig`, `Call`, `CallContext`, `CallEndedReport`, `TranscriptItem`, …). The Python worker mirrors them by hand. Field names are **snake_case** everywhere, and timestamps are **epoch milliseconds**.

---

## 1. Public API (`/v1`)

Sign-up is controlled by `ALLOW_SIGNUP` (`first` by default, which allows only the first account). Login and sign-up are rate-limited.

Auth works either way:
- **Dashboard:** HttpOnly session cookie `cl_session`, set by `/v1/auth/*`.
- **Server-to-server:** `Authorization: Bearer <api key>` (keys look like `cl_live_…`).

Errors return `{ "error": { "code": string, "message": string } }` with a proper HTTP status. Lists return `{ items, has_more, pagination_key? }`.

### Auth & org
| Method | Path | Body → Response |
|---|---|---|
| POST | `/v1/auth/signup` | `{email, password, name?, org_name?}` → `{user, org}` + cookie |
| POST | `/v1/auth/login` | `{email, password}` → `{user, org}` + cookie |
| POST | `/v1/auth/logout` | → `{ok:true}` (clears cookie) |
| GET | `/v1/session` | → `{user:{user_id,email,name}, org:{org_id,name,webhook_url,concurrency_limit}}` |
| PATCH | `/v1/org` | `{name?, webhook_url?: string\|null}` → org |
| GET | `/v1/org/webhook-secret` | → `{webhook_secret}` (the current signing secret) |
| POST | `/v1/org/webhook-secret` | → `{webhook_secret}` (rotates; the old secret stops working immediately) |
| GET | `/v1/api-keys` | → `{items:[{key_id,name,key_prefix,created_timestamp,last_used_timestamp}]}` |
| POST | `/v1/api-keys` | `{name}` → `{key_id, name, api_key}` (**plaintext shown once**, stored hashed) |
| DELETE | `/v1/api-keys/:key_id` | → `{ok:true}` |

### Agents (versioned)
An agent has a mutable **draft** (the latest version while unpublished) and immutable **published** versions.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/v1/agents` | → `{items: AgentSummary[]}` |
| POST | `/v1/agents` | `{name, config?: AgentConfigInput}` → `Agent` |
| GET | `/v1/agents/:agent_id` | `?version=N` optional → `Agent` |
| PATCH | `/v1/agents/:agent_id` | `{name?, config?: AgentConfigInput}` → `Agent`. Updates the draft. If the latest version is published, a new draft `latest+1` is created from it first. `config` is a full replacement, validated with `AgentConfig`. |
| DELETE | `/v1/agents/:agent_id` | → `{ok:true}` (soft delete) |
| GET | `/v1/agents/:agent_id/versions` | → `{items:[{version, base_version, is_published, title, updated_timestamp}]}` |
| POST | `/v1/agents/:agent_id/publish` | `{title?}` → `Agent` (publishes the current draft) |

```ts
type AgentSummary = { agent_id; name; latest_version; published_version: number|null; updated_timestamp; voice_provider; model };
type Agent = { agent_id; name; version; base_version: number|null; is_published; title: string|null;
               latest_version; published_version: number|null; config: AgentConfig; created_timestamp; updated_timestamp };
```

### Calls
| Method | Path | Body → Response |
|---|---|---|
| POST | `/v1/calls/web` | `{agent_id, agent_version?, dynamic_variables?: Record<string,string>, metadata?}` → `{call_id, access_token, livekit_url, call: Call}`. Uses the published version by default, or the draft if nothing is published yet. |
| POST | `/v1/calls/phone` | `{agent_id, agent_version?, from_number?, to_number, dynamic_variables?, metadata?}` → `{call_id, call}`. Needs `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` and `SIP_FROM_NUMBERS`, else `501 not_configured`. `from_number` must be one of `SIP_FROM_NUMBERS` (`400 from_number_not_allowed`) and defaults to the first. |
| GET | `/v1/calls` | `?limit=50&pagination_key=&agent_id=&status=` → `{items: Call[], has_more, pagination_key}`, newest first |
| GET | `/v1/calls/:call_id` | → `Call` |
| POST | `/v1/calls/:call_id/stop` | → `{ok:true}`. Deletes the LiveKit room; the worker then reports `manual_stopped`. If no report arrives within 15 s (the worker died), the API closes the call itself. |

### Meta
| GET | `/v1/meta/options` | → `{llm_models: string[], tts_providers: string[], voices: {provider, voice_id, name}[], stt_languages: string[]}` |

`GET /health` → `{ok:true, db:"pglite"|"postgres", livekit_configured:boolean, sip_configured:boolean}`

---

## 2. Internal API (voice worker ↔ API)

Header `x-internal-secret: $INTERNAL_API_SECRET` is required, or the API returns 401. Base URL `API_BASE_URL`.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/internal/calls/:call_id/context` | → `CallContext` = `{call:{call_id, call_type, direction, agent_id, agent_version, from_number, to_number, metadata}, agent_name, agent_config: AgentConfig, dynamic_variables}` |
| POST | `/internal/calls/:call_id/started` | `{started_at}` → `{ok:true}`; status → `ongoing`, fires `call_started` |
| POST | `/internal/calls/:call_id/ended` | `CallEndedReport` → `{ok:true}`; status → `ended` (or `error` for `error_*` reasons). The API then computes latency distributions and cost, runs post-call analysis, and fires `call_ended` then `call_analyzed`. Idempotent: a second `ended` for the same call is ignored. If the API had already closed the call provisionally (stop grace period or stale-call reaper), the first real report replaces that result and `call_ended` / `call_analyzed` are sent again with the real data. |

```ts
CallEndedReport = {
  ended_at: number,
  started_at?: number,                       // answer time; lets the API recover a lost `started` report
  disconnection_reason: "user_hangup"|"agent_hangup"|"manual_stopped"|"inactivity"|"max_duration_reached"|"dial_failed"|"dial_no_answer"|"dial_busy"|"concurrency_limit_reached"|"error_llm"|"error_stt"|"error_tts"|"error_worker"|"error_unknown",
  transcript: TranscriptItem[],              // see below, in time order
  collected_variables: Record<string,string>,
  latency: { e2e: number[], stt: number[], llm: number[], tts: number[] },   // per-turn samples in ms
  usage: { llm_model?, llm_prompt_tokens, llm_completion_tokens, llm_requests, tts_provider?, tts_characters, stt_audio_seconds },
  error_message?: string
}
TranscriptItem =
  | {role:"agent", content, start_ms?, end_ms?, interrupted?}
  | {role:"user", content, start_ms?, end_ms?}
  | {role:"tool_call_invocation", tool_call_id, name, arguments /* JSON string */, time_ms?}
  | {role:"tool_call_result", tool_call_id, content, successful, time_ms?}
```

---

## 3. LiveKit conventions

- **Room name = `call_id`.**
- The API creates an **explicit agent dispatch** (`AgentDispatchClient.createDispatch(call_id, LIVEKIT_AGENT_NAME, {metadata})`). `metadata` is the JSON string `{"call_id": "<id>"}`.
- The worker registers with `agent_name = LIVEKIT_AGENT_NAME` (default `call-lagao-agent`) and reads `call_id` from `ctx.job.metadata`.
- **Browser participant identity = `user`**, with a token TTL of 15 min that only grants joining that room.
- **Phone participant identity = `phone_user`**, created by the API through `SipClient.createSipParticipant` after the dispatch.
- The worker uses LiveKit Agents defaults so the browser SDK can rely on them:
  - transcriptions are published on text-stream topic `lk.transcription` (both user and agent; attribute `lk.transcription_final`)
  - agent state is the participant attribute `lk.agent.state`, one of `initializing|listening|thinking|speaking`
- **Ending a call:**
  - The `end_call` tool, the silence timeout or max duration makes the worker speak a goodbye if needed, report `ended`, then delete the room.
  - When the user leaves, the worker reports `user_hangup`.
  - `POST /v1/calls/:id/stop` deletes the room, and the worker reports `manual_stopped`.

**Worker behaviours worth knowing (livekit-agents 1.8.9):**
- A `phone_user` counts as answered (`started`) only once its `sip.callStatus` attribute becomes `active`. If it leaves before that, the reason is `dial_busy`, `dial_no_answer` or `dial_failed`.
- If no caller joins within `CALL_JOIN_TIMEOUT_S` (default 120 s), the worker reports `dial_no_answer`. The API stores calls that never started as `not_connected`.
- Safety net: calls still `registered` after 3 min become `not_connected`, and calls `ongoing` for more than 3 h become `error` (`error_worker`). Both go through the normal end path, so `call_ended` webhooks fire.
- Goodbyes on silence or max duration are generated by the LLM (without tools), so they follow the agent's language.
- Custom tools send `GET` arguments as query params and a JSON body for every other method. Non-public destinations are refused and redirects aren't followed, unless `ALLOW_PRIVATE_URLS=true`.

## 4. Turn-taking mapping (worker)

| AgentConfig | LiveKit Agents setting |
|---|---|
| `turn.responsiveness` r ∈ [0,1] | `min_endpointing_delay = 0.2 + (1-r)*1.0` s, `max_endpointing_delay = 2.0 + (1-r)*3.0` s |
| `turn.interruption_sensitivity` s ∈ [0,1] | `allow_interruptions = s > 0`; `min_interruption_duration = 0.2 + (1-s)*1.3` s; `min_interruption_words = 0 if s≥0.7 else 1 if s≥0.4 else 2` |
| `call.end_call_after_silence_ms` | user-away timer → say goodbye → `inactivity` |
| `call.max_call_duration_ms` | hard timer → `max_duration_reached` |
| `engine.start_speaker`, `engine.begin_message` | `agent` + text → `session.say(text)`; `agent` + null → `generate_reply()`; `user` → wait |
| `{{var}}` in prompt / begin_message | `renderTemplate` with `dynamic_variables` |

## 5. Webhooks (API → customer)

`POST` to the org `webhook_url` and the agent `config.webhook_url`, if set:
- Body: `{"event":"call_started"|"call_ended"|"call_analyzed","call":Call}`
- Header: `x-call-lagao-signature: v=<ms>,d=<hex HMAC-SHA256(org webhook_secret, body + ms)>`
- Retries: 3 attempts (0 s, 2 s, 8 s backoff), 10 s timeout each. Every delivery is logged in `webhook_deliveries`.
- Redirects are not followed. URLs resolving to loopback, private, link-local or reserved addresses are refused unless `ALLOW_PRIVATE_URLS=true`.
