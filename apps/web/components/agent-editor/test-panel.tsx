"use client";

import type { AgentState, CallLagaoWebClient, LiveTranscriptItem } from "@call-lagao/web-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mic, MicOff, Phone, PhoneOff, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, isApiError, isNotConfigured } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { Alert, Badge, Button, KeyValueEditor, cn } from "../ui";
import { PaneTitle } from "./section";

type Status = "idle" | "creating" | "connecting" | "connected" | "ended";

function friendlyError(err: unknown): string {
  if (isNotConfigured(err)) {
    return "Voice calling isn't configured on this server yet. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the API's .env, start the voice worker, then try again.";
  }
  if (err instanceof Error) {
    if (err.name === "NotAllowedError" || /permission denied/i.test(err.message)) {
      return "Microphone access was blocked. Allow microphone access for this site in your browser and try again.";
    }
    if (err.name === "NotFoundError") return "No microphone was found. Plug one in and try again.";
  }
  if (isApiError(err) && err.status === 429) return "Concurrency limit reached — wait for ongoing calls to finish.";
  return err instanceof Error ? err.message : String(err);
}

function TalkingBars({ active }: { active: boolean }) {
  return (
    <div className="flex h-6 items-end gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn("w-1 rounded-full bg-violet-400 transition-all", active ? "talk-bar h-6" : "h-1.5 opacity-40")}
          style={active ? { animationDelay: `${i * 0.12}s` } : undefined}
        />
      ))}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  initializing: "Agent is joining…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Agent speaking",
};

export function TestPanel({
  agentId,
  variables,
  prepare,
  dirty,
  readOnly,
  viewedVersion,
}: {
  agentId: string;
  /** `{{variables}}` detected in the prompt, used to prefill the inputs. */
  variables: string[];
  /** Saves unsaved changes if needed and returns the version to test. */
  prepare: () => Promise<number>;
  dirty: boolean;
  readOnly: boolean;
  viewedVersion: number | undefined;
}) {
  const qc = useQueryClient();
  const clientRef = useRef<CallLagaoWebClient | null>(null);
  const [vars, setVars] = useState<[string, string][]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LiveTranscriptItem[]>([]);
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [talking, setTalking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Prefill detected variables without dropping user-added rows.
  const varsKey = variables.join(",");
  useEffect(() => {
    setVars((rows) => {
      const have = new Set(rows.map(([k]) => k));
      const add = variables.filter((v) => !have.has(v)).map((v): [string, string] => [v, ""]);
      return add.length ? [...rows, ...add] : rows;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varsKey]);

  useEffect(() => {
    if (status !== "connected") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  // Hang up if the panel unmounts mid-call.
  useEffect(() => () => void clientRef.current?.stopCall(), []);

  const start = async () => {
    setError(null);
    setTranscript([]);
    setAgentState(null);
    setTalking(false);
    setMuted(false);
    setPlaybackBlocked(false);
    setCallId(null);
    setStatus("creating");
    try {
      const version = await prepare();
      const dynamic_variables = Object.fromEntries(vars.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      const res = await api.calls.createWeb({
        agent_id: agentId,
        agent_version: version,
        dynamic_variables,
        metadata: { source: "dashboard_test" },
      });
      setCallId(res.call_id);
      setStatus("connecting");

      const { CallLagaoWebClient } = await import("@call-lagao/web-sdk");
      const client = new CallLagaoWebClient();
      clientRef.current = client;
      client
        .on("call_started", () => {
          setStatus("connected");
          setStartedAt(Date.now());
          setNow(Date.now());
        })
        .on("call_ended", () => {
          setStatus("ended");
          setTalking(false);
          clientRef.current = null;
          qc.invalidateQueries({ queryKey: ["calls"] });
        })
        .on("agent_state", setAgentState)
        .on("agent_start_talking", () => setTalking(true))
        .on("agent_stop_talking", () => setTalking(false))
        .on("update", ({ transcript: t }) => setTranscript(t))
        .on("audio_playback", ({ playing }) => setPlaybackBlocked(!playing))
        .on("error", (e) => setError(friendlyError(e)));
      await client.startCall({ accessToken: res.access_token, livekitUrl: res.livekit_url });
      if (!client.canPlaybackAudio) setPlaybackBlocked(true);
    } catch (e) {
      setError(friendlyError(e));
      setStatus((s) => (s === "connecting" ? "ended" : "idle"));
      clientRef.current = null;
    }
  };

  const hangUp = async () => {
    await clientRef.current?.stopCall();
  };

  const toggleMute = async () => {
    const next = !muted;
    await clientRef.current?.mute(next);
    setMuted(next);
  };

  const inCall = status === "connecting" || status === "connected";
  const busy = status === "creating" || inCall;

  return (
    <div className="flex h-full flex-col">
      <PaneTitle
        right={
          status === "connected" ? (
            <Badge tone="green">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Live · {formatDuration(now - (startedAt ?? now))}
            </Badge>
          ) : status === "ended" ? (
            <Badge>Ended</Badge>
          ) : null
        }
      >
        Test your agent
      </PaneTitle>

      <div className="space-y-4 border-b border-line p-5">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Dynamic variables</div>
          <KeyValueEditor value={vars} onChange={setVars} disabled={busy} keyPlaceholder="name" valuePlaceholder="value" addLabel="Add variable" />
        </div>

        {!inCall ? (
          <Button variant="primary" className="w-full" onClick={start} loading={status === "creating"}>
            <Phone className="size-4" />
            {dirty && !readOnly ? "Save & start web call" : "Start web call"}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button className="flex-1" onClick={toggleMute} disabled={status !== "connected"}>
              {muted ? <MicOff className="size-4 text-red-300" /> : <Mic className="size-4" />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="danger" className="flex-1" onClick={hangUp}>
              <PhoneOff className="size-4" /> Hang up
            </Button>
          </div>
        )}
        {viewedVersion !== undefined && !inCall && (
          <p className="text-center text-[11px] text-subtle">Tests version v{viewedVersion} in your browser using your microphone.</p>
        )}
        {error && <Alert>{error}</Alert>}
        {playbackBlocked && inCall && (
          <Button
            className="w-full"
            onClick={async () => {
              await clientRef.current?.startAudioPlayback();
              setPlaybackBlocked(!(clientRef.current?.canPlaybackAudio ?? true));
            }}
          >
            <Volume2 className="size-4" /> Click to enable audio
          </Button>
        )}
      </div>

      {(inCall || status === "ended") && (
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <TalkingBars active={talking} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {status === "connecting" ? "Connecting…" : status === "ended" ? "Call ended" : STATE_LABEL[agentState ?? ""] ?? "Waiting for agent…"}
            </div>
            {callId && <div className="truncate font-mono text-[11px] text-subtle">{callId}</div>}
          </div>
          {status === "ended" && callId && (
            <Link href={`/calls/${callId}`} className="flex items-center gap-1 text-xs text-violet-300 hover:underline">
              Details <ExternalLink className="size-3" />
            </Link>
          )}
        </div>
      )}

      <div ref={scrollRef} className="min-h-48 flex-1 space-y-2.5 overflow-y-auto p-5">
        {transcript.length === 0 ? (
          <p className="pt-6 text-center text-sm text-subtle">
            {inCall ? "Say hello — the live transcript will appear here." : "Start a web call to talk to your agent. The live transcript appears here."}
          </p>
        ) : (
          transcript.map((t) => (
            <div key={t.id} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
                  t.role === "user" ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-elevated text-fg",
                  !t.final && "opacity-70",
                )}
              >
                {t.content}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
