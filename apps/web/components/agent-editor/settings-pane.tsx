"use client";

import { type AgentConfig, TTS_PROVIDERS } from "@call-lagao/shared";
import { BarChart3, Clock, Ear, MessagesSquare, Mic, Volume2, Webhook, Wrench } from "lucide-react";
import type { MetaOptions } from "@/lib/api";
import { humanize } from "@/lib/format";
import { Badge, Field, Input, Select, Slider } from "../ui";
import { AnalysisEditor } from "./analysis-editor";
import { PaneTitle, Section } from "./section";
import { ToolsEditor } from "./tools-editor";

export const FALLBACK_LANGUAGES = [
  "multi",
  "en",
  "en-US",
  "en-GB",
  "en-IN",
  "en-AU",
  "hi",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "ja",
  "ko",
  "zh",
  "ru",
  "tr",
];

const LANGUAGE_NAMES: Record<string, string> = {
  multi: "Multilingual (code-switching)",
};

function languageLabel(code: string): string {
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

function describeInterruption(s: number): string {
  if (s === 0) return "The agent can't be interrupted — it always finishes its sentence.";
  if (s < 0.4) return "Only long, deliberate speech interrupts the agent (ignores short backchannels like “okay”).";
  if (s < 0.7) return "Balanced: a word or two from the caller stops the agent.";
  return "Very sensitive: any speech immediately stops the agent. Best in quiet environments.";
}

function describeResponsiveness(r: number): string {
  const min = 0.2 + (1 - r) * 1.0;
  const max = 2.0 + (1 - r) * 3.0;
  return `Waits ~${min.toFixed(1)}s of silence after the caller stops (up to ${max.toFixed(1)}s when the turn seems unfinished). Lower values suit callers who pause mid-thought.`;
}

export function SettingsPane({
  config,
  setSection,
  setWebhook,
  readOnly,
  meta,
}: {
  config: AgentConfig;
  setSection: <K extends "engine" | "voice" | "stt" | "turn" | "call" | "analysis">(key: K, patch: Partial<AgentConfig[K]>) => void;
  setWebhook: (url: string | null) => void;
  readOnly: boolean;
  meta?: MetaOptions;
}) {
  const providers: string[] = meta?.tts_providers?.length ? meta.tts_providers : [...TTS_PROVIDERS];
  const voices = (meta?.voices ?? []).filter((v) => v.provider === config.voice.provider);
  const knownVoice = voices.some((v) => v.voice_id === config.voice.voice_id);
  const languages = meta?.stt_languages?.length ? meta.stt_languages : FALLBACK_LANGUAGES;
  const langOptions = languages.includes(config.stt.language) ? languages : [config.stt.language, ...languages];
  const analysisModels = meta?.llm_models?.length ? meta.llm_models : [config.analysis.model];
  const customTools = config.engine.tools.filter((t) => t.type === "custom").length;

  return (
    <div>
      <PaneTitle>Settings</PaneTitle>

      <Section title="Voice" icon={<Volume2 className="size-4" />} description={`${humanize(config.voice.provider)} · ${config.voice.voice_id}`}>
        <Field label="Provider">
          <Select
            value={config.voice.provider}
            disabled={readOnly}
            onChange={(e) => {
              const provider = e.target.value as AgentConfig["voice"]["provider"];
              const first = meta?.voices.find((v) => v.provider === provider);
              setSection("voice", { provider, voice_id: first?.voice_id ?? config.voice.voice_id, model: undefined });
            }}
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {humanize(p)}
              </option>
            ))}
          </Select>
        </Field>
        {voices.length > 0 && (
          <Field label="Voice">
            <Select
              value={knownVoice ? config.voice.voice_id : "__custom"}
              disabled={readOnly}
              onChange={(e) => e.target.value !== "__custom" && setSection("voice", { voice_id: e.target.value })}
            >
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                </option>
              ))}
              <option value="__custom">Custom voice ID…</option>
            </Select>
          </Field>
        )}
        <Field label="Voice ID" hint="Any voice ID from your provider account (e.g. a cloned ElevenLabs voice).">
          <Input
            value={config.voice.voice_id}
            readOnly={readOnly}
            onChange={(e) => setSection("voice", { voice_id: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Voice model" hint="Optional. Leave empty for the provider default.">
          <Input
            value={config.voice.model ?? ""}
            readOnly={readOnly}
            onChange={(e) => setSection("voice", { model: e.target.value || undefined })}
            placeholder={config.voice.provider === "elevenlabs" ? "eleven_flash_v2_5" : config.voice.provider === "cartesia" ? "sonic-2" : "gpt-4o-mini-tts"}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Speed">
          <Slider
            value={config.voice.speed}
            onChange={(v) => setSection("voice", { speed: v })}
            min={0.5}
            max={2}
            step={0.05}
            disabled={readOnly}
            format={(v) => `${v.toFixed(2)}×`}
            leftLabel="Slower"
            rightLabel="Faster"
          />
        </Field>
      </Section>

      <Section title="Speech recognition" icon={<Mic className="size-4" />} description={`Deepgram ${config.stt.model} · ${config.stt.language}`}>
        <Field label="Language" hint="Use Multilingual when callers switch languages mid-sentence (e.g. Hinglish).">
          <Select value={config.stt.language} disabled={readOnly} onChange={(e) => setSection("stt", { language: e.target.value })}>
            {langOptions.map((l) => (
              <option key={l} value={l}>
                {languageLabel(l)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" hint="Deepgram model, e.g. nova-3.">
          <Input
            value={config.stt.model}
            readOnly={readOnly}
            onChange={(e) => setSection("stt", { model: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>
      </Section>

      <Section title="Turn-taking" icon={<MessagesSquare className="size-4" />} description="Interruptions and response timing">
        <Field label="Interruption sensitivity" hint={describeInterruption(config.turn.interruption_sensitivity)}>
          <Slider
            value={config.turn.interruption_sensitivity}
            onChange={(v) => setSection("turn", { interruption_sensitivity: v })}
            min={0}
            max={1}
            step={0.05}
            disabled={readOnly}
            format={(v) => v.toFixed(2)}
            leftLabel="Never"
            rightLabel="Instantly"
          />
        </Field>
        <Field label="Responsiveness" hint={describeResponsiveness(config.turn.responsiveness)}>
          <Slider
            value={config.turn.responsiveness}
            onChange={(v) => setSection("turn", { responsiveness: v })}
            min={0}
            max={1}
            step={0.05}
            disabled={readOnly}
            format={(v) => v.toFixed(2)}
            leftLabel="Patient"
            rightLabel="Snappy"
          />
        </Field>
      </Section>

      <Section title="Call settings" icon={<Clock className="size-4" />} description="Duration and silence limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max call duration (minutes)" hint="1–120. The agent says goodbye and ends the call.">
            <Input
              type="number"
              min={1}
              max={120}
              step={1}
              readOnly={readOnly}
              value={Math.round(config.call.max_call_duration_ms / 60_000)}
              onChange={(e) => setSection("call", { max_call_duration_ms: Math.round(Number(e.target.value) * 60_000) })}
            />
          </Field>
          <Field label="End call after silence (seconds)" hint="10–3600. Ends with reason “inactivity”.">
            <Input
              type="number"
              min={10}
              max={3600}
              step={1}
              readOnly={readOnly}
              value={Math.round(config.call.end_call_after_silence_ms / 1000)}
              onChange={(e) => setSection("call", { end_call_after_silence_ms: Math.round(Number(e.target.value) * 1000) })}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Tools"
        icon={<Wrench className="size-4" />}
        description="End call and custom HTTP functions"
        badge={customTools > 0 ? <Badge tone="brand">{customTools}</Badge> : undefined}
      >
        <ToolsEditor tools={config.engine.tools} onChange={(tools) => setSection("engine", { tools })} readOnly={readOnly} />
      </Section>

      <Section
        title="Post-call analysis"
        icon={<BarChart3 className="size-4" />}
        description="Summary, sentiment and custom fields"
        defaultOpen={false}
        badge={config.analysis.fields.length > 0 ? <Badge tone="brand">{config.analysis.fields.length}</Badge> : undefined}
      >
        <Field label="Analysis model">
          <Select value={config.analysis.model} disabled={readOnly} onChange={(e) => setSection("analysis", { model: e.target.value })}>
            {(analysisModels.includes(config.analysis.model) ? analysisModels : [config.analysis.model, ...analysisModels]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <AnalysisEditor fields={config.analysis.fields} onChange={(fields) => setSection("analysis", { fields })} readOnly={readOnly} />
      </Section>

      <Section title="Webhook" icon={<Webhook className="size-4" />} description={config.webhook_url ?? "Not set"} defaultOpen={false}>
        <Field
          label="Agent webhook URL"
          hint="Receives call_started, call_ended and call_analyzed events for this agent, in addition to the org webhook. Signed with your org webhook secret."
        >
          <Input
            value={config.webhook_url ?? ""}
            readOnly={readOnly}
            onChange={(e) => setWebhook(e.target.value.trim() ? e.target.value : null)}
            placeholder="https://example.com/webhooks/call-lagao"
          />
        </Field>
      </Section>
      <div className="flex items-center gap-2 px-5 py-4 text-xs text-subtle">
        <Ear className="size-3.5" /> Changes apply to new calls after you save (and publish, for API calls).
      </div>
    </div>
  );
}
