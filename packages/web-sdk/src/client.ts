import {
  ConnectionState,
  DisconnectReason,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type TextStreamReader,
} from "livekit-client";
import { TypedEmitter } from "./emitter.js";
import {
  ATTR_SEGMENT_ID,
  ATTR_TRANSCRIPTION_FINAL,
  type LiveTranscriptItem,
  TranscriptAccumulator,
} from "./transcript.js";

/** Identity the API gives the browser participant (service contract §3, apps/api/README.md). */
export const USER_IDENTITY = "user";
export const TRANSCRIPTION_TOPIC = "lk.transcription";
export const AGENT_STATE_ATTRIBUTE = "lk.agent.state";

export type AgentState = "initializing" | "listening" | "thinking" | "speaking" | (string & {});

export type StartCallOptions = {
  /** `access_token` from `POST /v1/calls/web`. */
  accessToken: string;
  /** `livekit_url` from `POST /v1/calls/web`. */
  livekitUrl: string;
  /** Microphone deviceId (from `navigator.mediaDevices.enumerateDevices()`). */
  captureDeviceId?: string;
  /** Speaker deviceId; only honoured where `HTMLMediaElement.setSinkId` exists. */
  playbackDeviceId?: string;
};

export type UpdateEvent = {
  transcript: LiveTranscriptItem[];
};

export type CallEndedEvent = {
  /** LiveKit disconnect reason name, e.g. `ROOM_DELETED`, `CLIENT_INITIATED`. */
  reason?: string;
};

export type CallLagaoEvents = {
  call_started: void;
  call_ended: CallEndedEvent;
  agent_start_talking: void;
  agent_stop_talking: void;
  agent_state: AgentState;
  update: UpdateEvent;
  /** Fired when the browser blocks autoplay (`playing=false`) or playback resumes. */
  audio_playback: { playing: boolean };
  error: Error;
};

/**
 * Browser client for Call Lagao web calls.
 *
 * ```ts
 * const client = new CallLagaoWebClient();
 * client.on("update", ({ transcript }) => render(transcript));
 * await client.startCall({ accessToken, livekitUrl });
 * ```
 */
export class CallLagaoWebClient extends TypedEmitter<CallLagaoEvents> {
  private room: Room | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();
  private transcript = new TranscriptAccumulator();
  private agentState: AgentState | null = null;
  private ended = false;
  private playbackDeviceId: string | undefined;

  /** True while the agent's `lk.agent.state` is `speaking`. */
  isAgentTalking = false;

  get isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  /** Whether the browser currently allows audio playback (false until a user gesture on some browsers). */
  get canPlaybackAudio(): boolean {
    return this.room?.canPlaybackAudio ?? true;
  }

  get currentAgentState(): AgentState | null {
    return this.agentState;
  }

  /** Snapshot of the live transcript. */
  getTranscript(): LiveTranscriptItem[] {
    return this.transcript.items();
  }

  async startCall(opts: StartCallOptions): Promise<void> {
    if (this.room) throw new Error("A call is already in progress; call stopCall() first.");
    this.ended = false;
    this.isAgentTalking = false;
    this.agentState = null;
    this.transcript.clear();
    this.playbackDeviceId = opts.playbackDeviceId;

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(opts.captureDeviceId ? { deviceId: opts.captureDeviceId } : {}),
      },
      ...(opts.playbackDeviceId ? { audioOutput: { deviceId: opts.playbackDeviceId } } : {}),
    });
    this.room = room;
    this.bindRoomEvents(room);

    try {
      await room.connect(opts.livekitUrl, opts.accessToken, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true);
      // An agent may already be in the room before we connected.
      for (const p of room.remoteParticipants.values()) this.handleAttributes(p);
      this.emit("call_started", undefined);
    } catch (err) {
      const error = toError(err);
      this.emit("error", error);
      await this.teardown("CONNECT_FAILED");
      throw error;
    }
  }

  /** Hang up. Safe to call more than once. */
  async stopCall(): Promise<void> {
    if (!this.room) return;
    await this.teardown("CLIENT_INITIATED");
  }

  /** Mute (`true`) or unmute (`false`) the microphone. */
  async mute(muted: boolean): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err) {
      this.emit("error", toError(err));
    }
  }

  get isMuted(): boolean {
    return this.room ? !this.room.localParticipant.isMicrophoneEnabled : false;
  }

  /** Call from a click handler when the browser blocked autoplay (see `audio_playback` event). */
  async startAudioPlayback(): Promise<void> {
    if (!this.room) return;
    await this.room.startAudio();
    for (const el of this.audioElements.values()) {
      await el.play().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------

  private bindRoomEvents(room: Room): void {
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => this.onTrackSubscribed(track, participant))
      .on(RoomEvent.TrackUnsubscribed, (track) => this.detachTrack(track))
      .on(RoomEvent.ParticipantConnected, (p) => this.handleAttributes(p))
      .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => this.handleAttributes(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (this.isAgentParticipant(p)) this.setAgentState("listening");
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, (playing) => this.emit("audio_playback", { playing }))
      .on(RoomEvent.MediaDevicesError, (err) => this.emit("error", toError(err)))
      .on(RoomEvent.Disconnected, (reason) => {
        void this.teardown(reason !== undefined ? DisconnectReason[reason] : undefined);
      });

    room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader, info) => {
      void this.readTranscriptionStream(reader, info.identity);
    });
  }

  private isAgentParticipant(p: Participant): boolean {
    if (this.room && p.identity === this.room.localParticipant.identity) return false;
    return p.isAgent || (p.identity !== USER_IDENTITY && !p.identity.startsWith("phone_"));
  }

  private onTrackSubscribed(track: RemoteTrack, participant: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) return;
    if (typeof document === "undefined") return;
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "true");
    el.style.display = "none";
    el.dataset.participant = participant.identity;
    track.attach(el);
    document.body.appendChild(el);
    const key = track.sid ?? `${participant.identity}:${this.audioElements.size}`;
    this.audioElements.set(key, el);
    if (this.playbackDeviceId && "setSinkId" in el) {
      (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
        .setSinkId(this.playbackDeviceId)
        .catch(() => undefined);
    }
  }

  private detachTrack(track: RemoteTrack): void {
    for (const el of track.detach()) el.remove();
    if (track.sid) this.audioElements.delete(track.sid);
  }

  private handleAttributes(p: Participant): void {
    if (!this.isAgentParticipant(p)) return;
    const state = p.attributes[AGENT_STATE_ATTRIBUTE];
    if (state) this.setAgentState(state);
  }

  private setAgentState(state: AgentState): void {
    if (state === this.agentState) return;
    this.agentState = state;
    this.emit("agent_state", state);
    const talking = state === "speaking";
    if (talking !== this.isAgentTalking) {
      this.isAgentTalking = talking;
      this.emit(talking ? "agent_start_talking" : "agent_stop_talking", undefined);
    }
  }

  private async readTranscriptionStream(reader: TextStreamReader, identity: string): Promise<void> {
    const attrs = reader.info.attributes ?? {};
    const role = identity === USER_IDENTITY || identity.startsWith("phone_") ? "user" : "agent";
    const id = attrs[ATTR_SEGMENT_ID] || reader.info.id;
    const finalAttr = attrs[ATTR_TRANSCRIPTION_FINAL] === "true";
    this.transcript.begin(id, role, finalAttr);
    try {
      for await (const delta of reader) {
        this.transcript.append(id, delta);
        this.emitUpdate();
      }
      // Agent segments are delta streams: once the stream closes the segment is complete.
      // User streams carry an explicit final flag per interim result.
      const closingFinal = reader.info.attributes?.[ATTR_TRANSCRIPTION_FINAL] === "true";
      if (role === "agent" || finalAttr || closingFinal) this.transcript.markFinal(id);
      this.emitUpdate();
    } catch (err) {
      if (!this.ended) this.emit("error", toError(err));
    }
  }

  private emitUpdate(): void {
    this.emit("update", { transcript: this.transcript.items() });
  }

  private async teardown(reason?: string): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.room = null;
    try {
      room.unregisterTextStreamHandler(TRANSCRIPTION_TOPIC);
    } catch {
      /* already gone */
    }
    room.removeAllListeners();
    for (const el of this.audioElements.values()) el.remove();
    this.audioElements.clear();
    try {
      await room.disconnect(true);
    } catch {
      /* ignore */
    }
    if (this.isAgentTalking) {
      this.isAgentTalking = false;
      this.emit("agent_stop_talking", undefined);
    }
    if (!this.ended) {
      this.ended = true;
      this.emit("call_ended", { reason });
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
