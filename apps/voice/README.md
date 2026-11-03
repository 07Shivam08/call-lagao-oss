# Call Lagao voice worker

Python [LiveKit Agents](https://docs.livekit.io/agents/) worker that joins each call's
LiveKit room and runs the voice agent: Deepgram STT, OpenAI LLM, and ElevenLabs,
Cartesia or OpenAI TTS, with Silero VAD and an end-of-turn model.

Built against **livekit-agents 1.8.9** (pinned `>=1.8.9,<1.9`) on Python 3.13.

## Setup

```powershell
cd apps/voice
py -3.13 -m venv .venv
.venv\Scripts\activate            # bash: source .venv/Scripts/activate (Linux/macOS: .venv/bin/activate)
pip install -e ".[dev]"
python -m call_lagao_voice download-files   # Silero VAD + turn-detector model weights
python -m call_lagao_voice dev              # or `start` in production, `console` for a local mic test
pytest                                      # unit tests (no network, no LiveKit server)
```

> **Windows: `import livekit.agents` crashes with "access violation"?** Your system
> `msvcp140.dll` is older than 14.40, and onnxruntime needs the newer one. The proper
> fix is to install the current
> [VC++ Redistributable x64](https://aka.ms/vs/17/release/vc_redist.x64.exe). Until
> then, `call_lagao_voice/_winfix.py` loads the newer copy that numpy ships inside the
> venv. Set `CALL_LAGAO_NO_VCRT_SHIM=1` to turn it off.

## Environment

The worker reads the repo-root `.env` (`../../.env`), then `apps/voice/.env`. Variables
already set in the process win.

| Variable | Purpose |
|---|---|
| `API_BASE_URL` | API base URL for `/internal/*`. Default `http://localhost:4000`. |
| `INTERNAL_API_SECRET` | Sent as the `x-internal-secret` header. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit project credentials. |
| `LIVEKIT_AGENT_NAME` | Dispatch name. Default `call-lagao-agent`. |
| `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVEN_API_KEY`, `CARTESIA_API_KEY` | Provider keys. |
| `TURN_DETECTOR` | Optional: `multilingual` (default), `inference`, `vad` or `stt`. |
| `CALL_JOIN_TIMEOUT_S` | Optional: how long to wait for the caller to join or answer. Default `120`. |
| `ALLOW_PRIVATE_URLS` | Optional: `true` lets custom tools call localhost and private IPs (local development only). |

## Layout

```
src/call_lagao_voice/
  config.py      env + .env loading
  models.py      pydantic mirrors of packages/shared (AgentConfig, CallContext, CallEndedReport, ...)
  api_client.py  /internal/calls/:id/{context,started,ended}: retries 3x on network errors/5xx; ended is sent once
  mapping.py     pure: contract §4 turn mapping, render_template, greeting plan, plugin kwargs, end reasons
  tools.py       end_call + custom HTTP tools as raw-schema function tools
  netguard.py    SSRF guard for custom tool URLs (blocks private/loopback/metadata addresses)
  recorder.py    transcript, per-turn latency and usage, built from AgentSession events
  agent.py       entrypoint, CallController (call lifecycle), prewarm, WorkerOptions
  __main__.py    livekit CLI (dev | start | console | download-files)
```

## How it maps to the contract ([`apps/api/README.md`](../api/README.md))

- **Dispatch (§3):** `WorkerOptions(agent_name=LIVEKIT_AGENT_NAME)` enables explicit
  dispatch. `call_id` comes from `ctx.job.metadata` (`{"call_id": ...}`). If the metadata
  is missing, the room name is used.
- **Context:** `GET /internal/calls/:id/context`. `{{var}}` in the prompt and
  `begin_message` is filled from `dynamic_variables`. Unknown variables are left as they are.
- **Started:** posted once, when participant `user` (web) or `phone_user` (SIP) is
  present. A SIP callee counts only once `sip.callStatus == "active"`, meaning the call
  was answered. The transcript clock (`*_ms`) starts at the same moment.
- **Greeting (§4):** `start_speaker=agent` with text calls `session.say(text)`.
  `begin_message=null` calls `generate_reply()`. `start_speaker=user` or
  `begin_message=""` waits for the user.
- **Turn-taking (§4):** passed as `AgentSession(turn_handling=...)`, the 1.8 replacement
  for the deprecated flat kwargs:
  - `endpointing.min_delay = 0.2+(1-r)`
  - `endpointing.max_delay = 2+3(1-r)`
  - `interruption.enabled = s>0`
  - `interruption.min_duration = 0.2+1.3(1-s)`
  - `interruption.min_words`: 0, 1 or 2
  - `interruption.mode` is pinned to `"vad"`. Otherwise the cloud "adaptive" detector
    would run in dev but not in prod.
- **Ending:** the first trigger wins, and `ended` is posted exactly once:

  | Trigger | Reason |
  |---|---|
  | `end_call` tool. The agent finishes its goodbye first. | `agent_hangup` |
  | Silence: `user_away_timeout = end_call_after_silence_ms`. An LLM goodbye is spoken. | `inactivity` |
  | Hard timer, started at answer. An LLM goodbye is spoken. | `max_duration_reached` |
  | Caller left | `user_hangup` |
  | Room deleted (`/v1/calls/:id/stop`) | `manual_stopped` |
  | SIP callee left before answering | `dial_busy`, `dial_no_answer` or `dial_failed` |
  | Unrecoverable session error | `error_llm`, `error_stt` or `error_tts` |
  | Worker failure | `error_worker`, with `error_message` |

  Then the room is deleted, unless it is already gone, and the job shuts down.
- **Report:**
  - Transcript items come from `conversation_item_added`. Agent items carry
    `interrupted`.
  - Tool items come from the tools themselves, with `function_tools_executed` as a
    fallback.
  - Latency per turn comes from `ChatMessage.metrics`: `e2e_latency`,
    `transcription_delay`, `llm_node_ttft` and `tts_node_ttfb`, converted to ms.
  - Usage comes from `metrics_collected`: LLM/TTS/STT metrics.
