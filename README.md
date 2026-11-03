# Call Lagao

**Open-source, self-hostable platform for building voice AI agents that talk to people in the browser and over the phone.**

Write a prompt, pick a voice, add tools, and talk to your agent from the dashboard in seconds. Then call it from your own product with an API key and a small browser SDK. Every call is recorded as a transcript with tool calls, per-turn latency, an itemized cost estimate and an LLM-generated post-call analysis, and is pushed to your backend with signed webhooks.

> *Call lagao* is Hindi for "place a call".

[![License: AGPL v3](https://img.shields.io/badge/server-AGPL--3.0-blue.svg)](LICENSE)
[![License: MIT](https://img.shields.io/badge/SDK-MIT-green.svg)](packages/web-sdk/LICENSE)

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using Call Lagao](#using-call-lagao)
  - [1. Dashboard](#1-dashboard)
  - [2. REST API](#2-rest-api)
  - [3. Browser SDK](#3-browser-sdk)
  - [4. Phone calls](#4-phone-calls)
  - [5. Webhooks](#5-webhooks)
  - [6. Agent configuration reference](#6-agent-configuration-reference)
- [Running in production](#running-in-production)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Third-party services and licenses](#third-party-services-and-licenses)

---

## Features

- **Versioned agents.** Edit a draft, publish immutable versions, and pin a call to a specific version.
- **Real-time voice pipeline.** Deepgram speech-to-text, then end-of-turn detection, then an OpenAI LLM, then ElevenLabs, Cartesia or OpenAI text-to-speech. It runs on [LiveKit Agents](https://docs.livekit.io/agents/) with Silero VAD and LiveKit's turn-detector model.
- **Turn-taking controls.** Responsiveness and interruption sensitivity sliders map to endpointing and barge-in settings.
- **Tool calling.** A built-in `end_call` tool, plus custom HTTP tools that the LLM calls with JSON-schema arguments.
- **Dynamic variables.** `{{customer_name}}` placeholders in the prompt and greeting are filled per call.
- **Web calls.** A browser SDK (`@call-lagao/web-sdk`) emits events for call state, live transcripts and agent talking.
- **Outbound phone calls.** These go through LiveKit SIP and your own Twilio or Telnyx trunk.
- **Call history.** Full transcripts with tool calls, p50/p90/p95/p99 latency (end-to-end, STT, LLM, TTS), usage and an itemized cost estimate.
- **Post-call analysis.** You define the fields (string, boolean, number or enum) and an LLM fills them in after every call.
- **Signed webhooks.** `call_started`, `call_ended` and `call_analyzed` are sent with HMAC-SHA256 signatures and retries.
- **Multi-tenant.** Organizations, users, hashed API keys and HttpOnly session cookies. Every query is scoped to the caller's org.
- **Zero-setup dev database.** Embedded PGlite (Postgres in WASM) runs when `DATABASE_URL` is empty. Use real Postgres in production.

## How it works

```
                ┌──────────────────────── your app / dashboard ────────────────────────┐
                │  Browser  (apps/web dashboard, or your site + @call-lagao/web-sdk)   │
                └───────┬──────────────────────────────────────────────▲───────────────┘
        1. POST /v1/calls/web                                   live audio + transcripts
           (API key or session)                                       (WebRTC)
                        ▼                                              │
┌──────────────────────────────────┐   2. dispatch agent   ┌───────────┴───────────┐
│  API  (apps/api · Fastify · :4000)│ ───────────────────▶ │  LiveKit (Cloud or    │
│  auth · agents · calls · costs   │   + browser token     │  self-hosted server)  │
│  analysis · webhooks · Postgres  │                       └───────────▲───────────┘
└──────────────▲───────────────────┘                                   │ 3. joins room
               │ 4. /internal/calls/:id/{context,started,ended}         │    "call_…"
               │    (x-internal-secret)                    ┌───────────┴───────────┐
               └────────────────────────────────────────── │ Voice worker          │
                                                           │ (apps/voice · Python) │
                    5. call_started / call_ended /         │ STT → turn → LLM → TTS│
                       call_analyzed webhooks ──▶ you      └───────────────────────┘
```

1. Your server (or the dashboard) calls `POST /v1/calls/web`. The API creates a `call_…` record, creates a LiveKit room with the same name, dispatches the voice agent into it, and returns a short-lived browser token.
2. The browser joins the room with `CallLagaoWebClient`.
3. The voice worker picks up the job, fetches the agent config from the API, reports `started`, greets the caller and runs the conversation.
4. When the call ends (the caller hangs up, the `end_call` tool runs, a silence timeout or max duration hits, or someone calls stop), the worker reports `ended` with the transcript, latency samples and usage.
5. The API computes latency distributions and cost, runs post-call analysis, and sends signed webhooks.

The full service contract (every endpoint, payload and LiveKit convention) is in [`apps/api/README.md`](apps/api/README.md).

## Repository layout

```
apps/
  api/        Fastify API: auth, orgs, API keys, versioned agents, calls, internal worker API, analysis, webhooks
  web/        Next.js dashboard: agent editor with live test calls, call history, settings
  voice/      Python LiveKit Agents worker: the real-time voice pipeline (one job per call)
packages/
  shared/     TypeScript types + zod schemas shared by the API and dashboard (MIT)
  web-sdk/    Browser SDK: CallLagaoWebClient on top of livekit-client (MIT)
  db/         SQL migrations (applied automatically by the API on start)
```

| Package | Docs |
|---|---|
| API + service contract | [`apps/api/README.md`](apps/api/README.md) |
| Voice worker | [`apps/voice/README.md`](apps/voice/README.md) |
| Browser SDK | [`packages/web-sdk/README.md`](packages/web-sdk/README.md) |

---

## Quick start

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | 22 or newer | |
| [pnpm](https://pnpm.io) | 11 | `corepack enable` picks up the version pinned in `package.json` |
| [Python](https://www.python.org) | 3.11 or newer (3.13 tested) | for the voice worker |
| Git | any | |

Live calls also need accounts with these providers. All of them have free tiers or trial credit:

| Provider | What for | Get keys at |
|---|---|---|
| **LiveKit** | real-time audio rooms (WebRTC + SIP) | [cloud.livekit.io](https://cloud.livekit.io) → your project → **Settings → Keys**. Or [self-host LiveKit](https://docs.livekit.io/home/self-hosting/). |
| **Deepgram** | speech-to-text | [console.deepgram.com](https://console.deepgram.com) |
| **OpenAI** | LLM + post-call analysis (+ optional TTS) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **ElevenLabs** *or* **Cartesia** | text-to-speech | [elevenlabs.io](https://elevenlabs.io) / [play.cartesia.ai](https://play.cartesia.ai) |

You can skip the provider keys at first. Everything except live calls (sign-up, agents, API keys, call history and webhooks) works without them, and the API answers `503 voice_not_configured` when you try to start a call.

### 1. Clone and install

```bash
git clone https://github.com/07Shivam08/call-lagao-oss.git call-lagao
cd call-lagao
corepack enable            # once per machine, makes the pinned pnpm available
pnpm install
pnpm --filter @call-lagao/shared build
pnpm --filter @call-lagao/web-sdk build
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set at least `INTERNAL_API_SECRET` to a long random string. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the LiveKit and provider keys when you want to make real calls. See [Configuration](#configuration) for every variable. **Never commit `.env`.** It is already in `.gitignore`.

### 3. Start the API and the dashboard

Use two terminals:

```bash
pnpm dev:api     # http://localhost:4000   (creates an embedded database in .data/ on first run)
pnpm dev:web     # http://localhost:3000
```

Open <http://localhost:3000>, click **Sign up** and create your account and organization.

By default only the **first** account can sign up. After that, sign-up is closed (`ALLOW_SIGNUP=first`). Set `ALLOW_SIGNUP=true` if you want to add more accounts, for example to try multi-tenancy locally.

### 4. Start the voice worker

Use a third terminal:

```bash
cd apps/voice
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -e ".[dev]"
python -m call_lagao_voice download-files   # one-time download of the VAD and turn-detector models
python -m call_lagao_voice dev              # registers with LiveKit and waits for calls
```

The worker reads the same root `.env`.

### 5. Make your first call

1. In the dashboard, go to **Agents → New agent**.
2. Write a prompt, pick a voice, and click **Test call**. Allow microphone access and start talking.
3. Hang up, then open **Calls** to see the transcript, latency, cost and analysis.

No keys yet but want to see a populated call history? Stop the API, run `pnpm --filter @call-lagao/api seed:demo you@example.com` (use the email you signed up with), and start the API again.

---

## Configuration

All services read the repo-root `.env`. Real environment variables always take precedence. The voice worker also reads an optional `apps/voice/.env`.

### API (`apps/api`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `INTERNAL_API_SECRET` | **yes** | – | Shared secret between the API and the voice worker (sent as `x-internal-secret`). Use at least 32 random characters. A short or placeholder value prints a warning in dev and stops the API in production. |
| `API_PORT` | no | `4000` | Port the API listens on. |
| `API_BASE_URL` | no | `http://localhost:4000` | Public URL of the API. The voice worker uses it to reach `/internal/*`. |
| `WEB_ORIGIN` | no | `http://localhost:3000` | Dashboard origin, allowed by CORS. |
| `DATABASE_URL` | prod | *(empty → PGlite)* | Postgres connection string, e.g. `postgres://user:pass@host:5432/call_lagao`. If empty, an embedded database is created in `.data/` (dev only, single process). |
| `NODE_ENV` | prod | – | Set to `production` in deployments. Weak secrets become fatal and session cookies are marked `Secure` (cookies are also `Secure` whenever `WEB_ORIGIN` is `https://`). |
| `ALLOW_SIGNUP` | no | `first` | Who can create accounts. `first` allows sign-up only until the first account exists, `true` allows anyone, `false` allows nobody. |
| `ALLOW_PRIVATE_URLS` | no | `false` | `true` lets webhooks (API) and custom tools (worker) call `localhost` and private IPs. Use it for local development only (see [Security model](#security-model)). |
| `LIVEKIT_URL` | for calls | – | `wss://<project>.livekit.cloud` or your self-hosted URL. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | for calls | – | LiveKit project keys, used for agent dispatch and browser tokens. |
| `LIVEKIT_AGENT_NAME` | no | `call-lagao-agent` | Name the worker registers under. Must match on both sides. |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | for phone | – | LiveKit outbound SIP trunk id (`ST_…`). Phone calls return `501` without it. |
| `SIP_FROM_NUMBERS` | for phone | – | Comma-separated caller IDs (E.164) your trunk owns, e.g. `+14155550100,+14155550101`. Calls may only use these as `from_number`, and the first is the default, so tenants can't spoof caller ID. Phone calls return `501` without it. |
| `OPENAI_API_KEY` | no | – | Enables post-call analysis. Without it, analysis is skipped. |

### Voice worker (`apps/voice`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_BASE_URL`, `INTERNAL_API_SECRET` | **yes** | – | Must match the API. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME` | **yes** | – | Same LiveKit project as the API. |
| `OPENAI_API_KEY` | **yes** | – | LLM (and OpenAI TTS voices). |
| `DEEPGRAM_API_KEY` | **yes** | – | Speech-to-text. |
| `ELEVEN_API_KEY` | if using ElevenLabs | – | `ELEVENLABS_API_KEY` is also accepted. |
| `CARTESIA_API_KEY` | if using Cartesia | – | |
| `TURN_DETECTOR` | no | `multilingual` | End-of-turn detection: `multilingual` (local model), `inference` (LiveKit Cloud), `vad` or `stt`. |
| `CALL_JOIN_TIMEOUT_S` | no | `120` | Seconds to wait for the caller to join or answer before reporting `dial_no_answer`. |
| `ALLOW_PRIVATE_URLS` | no | `false` | Same as for the API: lets custom tools call private addresses. |
| `CALL_LAGAO_NO_VCRT_SHIM` | no | – | Windows only. Set to `1` to disable the MSVC runtime workaround (see [Troubleshooting](#troubleshooting)). |

### Dashboard (`apps/web`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_INTERNAL_URL` | no | `http://localhost:4000` | Where the Next.js server proxies `/api/v1/*` and `/api/health`. The browser only talks to the dashboard origin, so the session cookie stays first-party. The value is baked in by `next build`, so set it before building. |

---

## Using Call Lagao

### 1. Dashboard

| Page | What you can do |
|---|---|
| **Agents** | Create agents. Edit the prompt, greeting, LLM, voice, language, turn-taking, timeouts, tools and analysis fields. Publish versions and run **test calls** from the browser. |
| **Calls** | Filter call history by agent and status. Each call shows the transcript (including tool calls), recording metadata, latency percentiles, cost breakdown, disconnection reason and analysis. |
| **Phone Numbers** | Setup guide for outbound SIP calling. |
| **Settings** | Rename the org, set the org-wide webhook URL, rotate the webhook signing secret, and create or revoke API keys. |

### 2. REST API

Create an API key in **Settings → API keys**. It is shown once and starts with `cl_live_`. Keep it on your server, because anyone holding it can act as your org.

```bash
export CL=http://localhost:4000
export KEY=cl_live_xxxxxxxxxxxxxxxx

# Create an agent
curl -s $CL/v1/agents -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "name": "Appointment reminder",
  "config": {
    "engine": {
      "prompt": "You are Maya from Sunrise Dental. Remind {{customer_name}} about their appointment on {{date}} and ask them to confirm.",
      "begin_message": "Hi {{customer_name}}, this is Maya from Sunrise Dental!",
      "model": "gpt-4.1-mini"
    },
    "voice": { "provider": "elevenlabs", "voice_id": "21m00Tcm4TlvDq8ikWAM" },
    "analysis": { "fields": [
      { "name": "confirmed", "type": "boolean", "description": "Did the customer confirm the appointment?" }
    ] }
  }
}'
# -> { "agent_id": "agent_…", "version": 0, ... }

# Publish the draft (calls use the published version by default)
curl -s -X POST $CL/v1/agents/agent_XXXX/publish -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"title":"v1"}'

# Start a web call. Give access_token + livekit_url to the browser SDK.
curl -s $CL/v1/calls/web -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "agent_id": "agent_XXXX",
  "dynamic_variables": { "customer_name": "Asha", "date": "Friday at 4 pm" },
  "metadata": { "crm_id": "123" }
}'
# -> { "call_id": "call_…", "access_token": "…", "livekit_url": "wss://…", "call": { … } }

# Read a finished call (transcript, latency, cost, analysis)
curl -s $CL/v1/calls/call_XXXX -H "Authorization: Bearer $KEY"

# List calls (cursor pagination)
curl -s "$CL/v1/calls?limit=20&agent_id=agent_XXXX" -H "Authorization: Bearer $KEY"
```

| Area | Endpoints |
|---|---|
| Agents | `GET/POST /v1/agents` · `GET/PATCH/DELETE /v1/agents/:id` · `GET /v1/agents/:id/versions` · `POST /v1/agents/:id/publish` |
| Calls | `POST /v1/calls/web` · `POST /v1/calls/phone` · `GET /v1/calls` · `GET /v1/calls/:id` · `POST /v1/calls/:id/stop` |
| Org | `GET /v1/session` · `PATCH /v1/org` · `POST /v1/org/webhook-secret` · `GET/POST/DELETE /v1/api-keys` |
| Meta | `GET /v1/meta/options` (models, voices, languages) · `GET /health` |

Errors look like `{ "error": { "code": "…", "message": "…" } }` and come with a matching HTTP status. Full request and response shapes are in [`apps/api/README.md`](apps/api/README.md).

### 3. Browser SDK

```bash
pnpm add @call-lagao/web-sdk livekit-client
```

The SDK is not published to npm yet. Until it is, build it from `packages/web-sdk` and add it as a workspace or file dependency.

```ts
import { CallLagaoWebClient } from "@call-lagao/web-sdk";

// access_token + livekit_url come from POST /v1/calls/web, made by YOUR server
const client = new CallLagaoWebClient();
client.on("call_started", () => console.log("connected"));
client.on("update", ({ transcript }) => render(transcript));        // live transcript
client.on("agent_start_talking", () => setTalking(true));
client.on("agent_stop_talking", () => setTalking(false));
client.on("call_ended", ({ reason }) => console.log("ended", reason));

button.onclick = () => client.startCall({ accessToken: access_token, livekitUrl: livekit_url });
hangup.onclick = () => client.stopCall();
```

Call `startCall` from a click handler so the browser allows the microphone and audio playback. Full event reference: [`packages/web-sdk/README.md`](packages/web-sdk/README.md).

### 4. Phone calls

Outbound calls go through LiveKit SIP. You bring your own carrier.

1. Create an Elastic SIP trunk at [Twilio](https://www.twilio.com/docs/sip-trunking) or [Telnyx](https://developers.telnyx.com/docs/voice/sip-trunking), and buy or port a number on it.
2. Register it as a [LiveKit outbound trunk](https://docs.livekit.io/sip/trunk-outbound/). In `.env`, set `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` and set `SIP_FROM_NUMBERS` to the number(s) you own on that trunk.
3. Place a call:

```bash
curl -s $CL/v1/calls/phone -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "agent_id": "agent_XXXX", "to_number": "+14155550123",
  "dynamic_variables": { "customer_name": "Asha" }
}'
```

`from_number` is optional and defaults to the first `SIP_FROM_NUMBERS` entry. Any other caller ID is rejected with `400 from_number_not_allowed`. The call counts as *started* only when the callee answers. Unanswered calls end with `dial_no_answer`, `dial_busy` or `dial_failed`.

### 5. Webhooks

Set an org-wide URL in **Settings** and/or a per-agent `webhook_url`. Each event is a `POST` with the body `{"event": "call_started" | "call_ended" | "call_analyzed", "call": { … }}` and the header:

```
x-call-lagao-signature: v=<epoch ms>,d=<hex HMAC-SHA256(webhook_secret, raw_body + epoch_ms)>
```

Deliveries are retried 3 times (0 s, 2 s, 8 s) with a 10 s timeout. Redirects are not followed, and URLs that resolve to private addresses are refused unless `ALLOW_PRIVATE_URLS=true` (for testing against `localhost`, use that flag or a tunnel such as ngrok). **Always verify the signature** against the raw request body, using the secret from **Settings → Show webhook secret** (or `GET /v1/org/webhook-secret`):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyCallLagao(rawBody: string, header: string, secret: string): boolean {
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m || Math.abs(Date.now() - Number(m[1])) > 5 * 60_000) return false; // 5-minute replay window
  const expected = createHmac("sha256", secret).update(rawBody + m[1]).digest();
  const given = Buffer.from(m[2], "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

If a voice worker dies mid-call, the API closes the call itself (15 s after a stop, or through a safety net for stale calls). If the worker's real report arrives later, it replaces that result and `call_ended` / `call_analyzed` are sent again. Treat the latest event for a `call_id` as authoritative.

The same helper ships as `verifyWebhook` in `@call-lagao/shared/webhook`.

### 6. Agent configuration reference

`config` is validated by the [`AgentConfig`](packages/shared/src/agent.ts) zod schema. Every field has a default, so `{}` is a valid agent.

| Field | Default | Notes |
|---|---|---|
| `engine.prompt` | friendly assistant | System prompt. Supports `{{variables}}`. |
| `engine.begin_message` | `"Hi! How can I help you today?"` | `null` lets the LLM write the greeting; `""` waits for the user to speak first. |
| `engine.start_speaker` | `agent` | `agent` or `user`. |
| `engine.model` / `engine.temperature` | `gpt-4.1-mini` / `0.4` | |
| `engine.tools` | `[end_call]` | `{type:"end_call"}` or `{type:"custom", name, description, url, method, headers, parameters (JSON Schema), timeout_ms, speak_during_execution, execution_message}` |
| `voice.provider` / `voice.voice_id` / `voice.speed` | `elevenlabs` / Rachel / `1` | Providers: `elevenlabs`, `cartesia`, `openai`. |
| `stt.model` / `stt.language` | `nova-3` / `en` | BCP-47 code, or `multi` for code-switching (e.g. Hindi + English). |
| `turn.responsiveness` | `0.8` | 0 = waits long before replying, 1 = replies as soon as possible. |
| `turn.interruption_sensitivity` | `0.8` | 0 = can't be interrupted, 1 = any speech interrupts. |
| `call.max_call_duration_ms` | 30 min | Hard limit; the agent says goodbye. |
| `call.end_call_after_silence_ms` | 60 s | Silence timeout; the agent says goodbye. |
| `analysis.fields` | `[]` | `{name, type: string\|boolean\|number\|enum, description, choices?}` |
| `webhook_url` | `null` | Per-agent webhook, sent in addition to the org webhook. |

Custom tools are called by the **voice worker**. `GET` sends arguments as query parameters; every other method sends a JSON body. The response text is given back to the LLM. Only point tools at endpoints you control, and use `headers` for auth. Tool URLs must be public: the worker refuses loopback, private and cloud-metadata addresses and doesn't follow redirects, unless `ALLOW_PRIVATE_URLS=true`.

Cost figures are **estimates** computed from the rate table in [`packages/shared/src/metrics.ts`](packages/shared/src/metrics.ts). Edit it to match your provider contracts.

---

## Running in production

- **Database:** set `DATABASE_URL` to a managed Postgres instance (Neon, Supabase, RDS, …). Migrations run automatically on API start. PGlite is for development only and allows a single process.
- **Secrets:** use a long random `INTERNAL_API_SECRET`. Keep provider keys in your platform's secret manager, not in files.
- **Accounts:** leave `ALLOW_SIGNUP` at `first` (or `false`) on public servers. Anyone who signs up can spend your provider credits and SIP minutes.
- **HTTPS:** serve the dashboard and API over TLS and set `NODE_ENV=production` so session cookies are `Secure`. Set `WEB_ORIGIN` to the real dashboard origin and `API_BASE_URL` to the URL the worker can reach.
- **Build and run:**
  ```bash
  pnpm install --frozen-lockfile
  pnpm build                                   # shared, web-sdk, api (tsc) and web (next build)
  NODE_ENV=production pnpm --filter @call-lagao/api start
  NODE_ENV=production pnpm --filter @call-lagao/web start
  cd apps/voice && python -m call_lagao_voice start   # production mode; run as many workers as you need
  ```
- **Scaling:** the API is stateless and can run behind a load balancer. Voice workers scale horizontally: LiveKit hands each call to one available worker. Plan for roughly 1 CPU core per 4–6 concurrent calls with the local turn-detector model, or use `TURN_DETECTOR=inference` to offload it.
- **Network:** the worker needs outbound access to LiveKit, the model providers and `API_BASE_URL`. The dashboard proxy never forwards `/internal/*`. If you can, expose the API's `/internal/*` routes only to your workers (for example, on a private network).

## Tests

```bash
pnpm --filter @call-lagao/shared test     # schemas, pricing, percentiles, webhook signing
pnpm --filter @call-lagao/web-sdk test    # transcript merging
pnpm --filter @call-lagao/api test        # end-to-end API: auth, keys, versioning, call lifecycle, webhooks, tenancy
pnpm -r typecheck
cd apps/voice && pytest                   # worker: mapping, tools, recorder, API client (no network needed)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `503 voice_not_configured` when starting a call | Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `.env` and restart the API. |
| Call connects but the agent never speaks | Is the voice worker running, with the same `LIVEKIT_AGENT_NAME` and LiveKit project as the API? Check its terminal for provider-key errors. |
| Worker logs `401` from `/internal/...` | `INTERNAL_API_SECRET` differs between the API and the worker. |
| `403 signup_disabled` | Sign-up closes after the first account. Set `ALLOW_SIGNUP=true` and restart the API to add more. |
| Webhook or tool result says "blocked" / "private or reserved address" | The URL points at `localhost` or a private network. Use a public URL or tunnel, or set `ALLOW_PRIVATE_URLS=true` locally. |
| `PGlite` lock / "database is in use" | The embedded DB allows one process. Stop the API before running `seed:demo`, or use Postgres. |
| No audio in the browser | Browsers block autoplay until the user clicks. Start calls from a click, or call `client.startAudioPlayback()` on the `audio_playback` event. |
| Windows: `import livekit.agents` crashes with "access violation" | Install the latest [VC++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe). The worker includes a temporary shim (`_winfix.py`); disable it with `CALL_LAGAO_NO_VCRT_SHIM=1`. |
| `download-files` fails | You need network access to Hugging Face for the VAD and turn-detector weights. Or set `TURN_DETECTOR=vad` to skip the turn model. |

## Roadmap

- **Telephony:** buy or import numbers, inbound calls via LiveKit SIP dispatch, inbound routing, call transfer, voicemail detection.
- **Conversation flows:** node-graph engine and visual editor.
- **Scale:** knowledge bases (RAG), batch call campaigns, analytics dashboards, QA, alerting, PII redaction.

## Contributing

Issues and pull requests are welcome.

1. Fork, then create a branch from `main`.
2. Run the [tests](#tests) and `pnpm -r typecheck` before you open a PR.
3. Keep changes focused, and describe *why* in the PR.
4. By submitting a contribution, you agree it is licensed under the license of the package you changed (AGPL-3.0 or MIT, see below). You also agree that the maintainers may offer the project under additional licenses.

## Security

### Security model

- Passwords are hashed with scrypt. API keys and session tokens are stored only as SHA-256 hashes. Session cookies are `HttpOnly` and `SameSite=Lax`.
- Every `/v1` query is scoped to the caller's organization. The worker API (`/internal/*`) requires `INTERNAL_API_SECRET`, compared in constant time.
- Webhooks are HMAC-signed. Webhook and custom-tool URLs are checked against private, loopback and metadata IP ranges. Note that a determined DNS-rebinding attacker can race this check, so also run workers and the API without access to sensitive internal services.
- Login (per email) and sign-up (per IP) are rate-limited in memory.

### Reporting a vulnerability

Please **do not** open public issues for vulnerabilities. Report them privately through GitHub's **Security → Report a vulnerability** on this repository. Never post real API keys, call recordings or customer data in issues.

## License

Call Lagao is split-licensed, so that you can embed the client side anywhere while improvements to the server stay open:

| Component | License |
|---|---|
| `apps/api`, `apps/web`, `apps/voice`, `packages/db` and everything else not listed below | [GNU AGPL-3.0](LICENSE) |
| `packages/web-sdk`, `packages/shared` | [MIT](packages/web-sdk/LICENSE) |

**What this means in practice:**

- You can use, self-host, modify and run Call Lagao for any purpose, **including commercially**.
- If you modify the AGPL parts and let other people use them over a network (for example, as a hosted service), you must make your modified source code available to those users under the AGPL.
- The MIT-licensed SDK and shared types can be used in closed-source apps with no obligations beyond keeping the copyright notice.
- Commercial licenses without the AGPL obligations are available from the maintainers. Open an issue or contact the repository owner.

## Third-party services and licenses

Call Lagao is glue around excellent third-party software and APIs. All bundled npm and PyPI dependencies use permissive licenses (MIT, Apache-2.0, BSD, ISC and similar) that allow commercial use. A few things to know:

- **LiveKit turn-detector model.** `livekit-plugins-turn-detector` downloads model weights under the [LiveKit Model License](https://huggingface.co/livekit/turn-detector/blob/main/LICENSE). They may be used **only together with LiveKit Agents**, which is how this project uses them. Don't extract or reuse the model elsewhere. Set `TURN_DETECTOR=vad` or `stt` if you'd rather not use it.
- **Hosted APIs.** LiveKit Cloud, Deepgram, OpenAI, ElevenLabs, Cartesia, Twilio and Telnyx are separate commercial services with their own terms and pricing. You need your own accounts, and you are responsible for complying with their terms. For example, some free TTS tiers don't allow commercial use, and AI voice and outbound-calling rules such as consent and disclosure vary by country.
- **Voice IDs.** The starter voice IDs in `apps/api/src/routes/meta.ts` are providers' public premade voices.
- **Trademarks.** LiveKit, OpenAI, Deepgram, ElevenLabs, Cartesia, Twilio and Telnyx are trademarks of their respective owners. Call Lagao is not affiliated with or endorsed by them.
