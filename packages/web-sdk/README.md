# @call-lagao/web-sdk

Browser SDK for Call Lagao web calls. It wraps [`livekit-client`](https://github.com/livekit/client-sdk-js) and gives you a small, typed event API for call state, live transcripts and agent talking events.

## Install

```bash
pnpm add @call-lagao/web-sdk
```

## Usage

1. **On your server**, create a web call with your API key (never expose the key in the browser):

```ts
const res = await fetch("https://api.your-call-lagao.host/v1/calls/web", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.CALL_LAGAO_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ agent_id: "agent_…", dynamic_variables: { customer_name: "Asha" } }),
});
const { call_id, access_token, livekit_url } = await res.json();
```

2. **In the browser**, start the call with the returned token:

```ts
import { CallLagaoWebClient } from "@call-lagao/web-sdk";

const client = new CallLagaoWebClient();

client.on("call_started", () => console.log("connected"));
client.on("call_ended", ({ reason }) => console.log("ended", reason));
client.on("agent_start_talking", () => setTalking(true));
client.on("agent_stop_talking", () => setTalking(false));
client.on("agent_state", (state) => console.log(state)); // initializing | listening | thinking | speaking
client.on("update", ({ transcript }) => render(transcript)); // [{ id, role: "agent"|"user", content, final }]
client.on("audio_playback", ({ playing }) => !playing && showUnmuteButton());
client.on("error", (err) => console.error(err));

await client.startCall({
  accessToken: access_token,
  livekitUrl: livekit_url,
  // captureDeviceId?: string, playbackDeviceId?: string
});

await client.mute(true);   // mute mic
await client.mute(false);  // unmute
client.isAgentTalking;     // boolean
await client.stopCall();   // hang up
```

Call `startCall` from a user gesture (a click) so browsers allow microphone access and audio playback. If the browser still blocks autoplay, the `audio_playback` event fires with `playing: false`; call `client.startAudioPlayback()` from a click handler to resume.

## How it works

- Joins the LiveKit room (room name = `call_id`) as identity `user` and publishes the microphone with echo cancellation, noise suppression and auto gain control.
- Plays the agent's audio track through a hidden `<audio autoplay>` element.
- Agent state comes from the agent participant attribute `lk.agent.state`. `agent_start_talking` / `agent_stop_talking` fire on transitions into and out of `speaking`.
- Live transcripts come from LiveKit text streams on topic `lk.transcription`. Partials are merged by `lk.segment_id`; `final` reflects `lk.transcription_final` (agent segments become final when their stream closes).

The full, post-processed transcript (with tool calls, latency and cost) is available afterwards from `GET /v1/calls/:call_id`.
