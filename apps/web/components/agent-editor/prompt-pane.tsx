"use client";

import type { AgentConfig } from "@call-lagao/shared";
import { Braces } from "lucide-react";
import { Badge, Field, Select, Slider, Switch, Textarea } from "../ui";
import { PaneTitle } from "./section";

type Engine = AgentConfig["engine"];

export function PromptPane({
  engine,
  onChange,
  readOnly,
  models,
  variables,
}: {
  engine: Engine;
  onChange: (patch: Partial<Engine>) => void;
  readOnly: boolean;
  models: string[];
  variables: string[];
}) {
  const llmGreeting = engine.begin_message === null;
  const modelOptions = models.includes(engine.model) ? models : [engine.model, ...models];

  return (
    <div>
      <PaneTitle>Prompt</PaneTitle>
      <div className="space-y-5 p-5">
        <Field
          label="System prompt"
          hint={
            <>
              Describe the agent&apos;s role, tone and goals. Insert dynamic variables with{" "}
              <code className="rounded bg-elevated px-1 font-mono text-[11px] text-violet-300">{"{{variable_name}}"}</code> — they&apos;re
              filled from the call&apos;s <code className="font-mono text-[11px]">dynamic_variables</code>.
            </>
          }
        >
          <Textarea
            value={engine.prompt}
            readOnly={readOnly}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={18}
            spellCheck={false}
            className="min-h-72 resize-y font-mono text-[13px]"
            placeholder={"## Role\nYou are a friendly receptionist for {{business_name}}…"}
          />
        </Field>

        {variables.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Braces className="size-3.5 text-subtle" />
            <span className="text-xs text-subtle">Variables:</span>
            {variables.map((v) => (
              <Badge key={v} tone="brand" className="font-mono">
                {v}
              </Badge>
            ))}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who speaks first">
            <Select
              value={engine.start_speaker}
              disabled={readOnly}
              onChange={(e) => onChange({ start_speaker: e.target.value as Engine["start_speaker"] })}
            >
              <option value="agent">Agent speaks first</option>
              <option value="user">User speaks first</option>
            </Select>
          </Field>
          <Field label="LLM">
            <Select value={engine.model} disabled={readOnly} onChange={(e) => onChange({ model: e.target.value })}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {engine.start_speaker === "agent" && (
          <Field
            label="Begin message"
            right={
              <label className="flex items-center gap-2 text-xs text-muted">
                Let the LLM greet
                <Switch
                  checked={llmGreeting}
                  disabled={readOnly}
                  onChange={(v) => onChange({ begin_message: v ? null : "Hi! How can I help you today?" })}
                  label="Let the LLM generate the greeting"
                />
              </label>
            }
            hint={
              llmGreeting
                ? "The model generates the opening line from your prompt."
                : "Spoken verbatim when the call connects. Supports {{variables}}."
            }
          >
            {!llmGreeting && (
              <Textarea
                value={engine.begin_message ?? ""}
                readOnly={readOnly}
                onChange={(e) => onChange({ begin_message: e.target.value })}
                rows={2}
                className="resize-y"
                placeholder="Hi {{customer_name}}, this is Maya from…"
              />
            )}
          </Field>
        )}

        <Field
          label="Temperature"
          hint="Lower is more focused and predictable; higher is more varied. 0.2–0.6 works well for voice."
        >
          <Slider
            value={engine.temperature}
            onChange={(v) => onChange({ temperature: v })}
            min={0}
            max={2}
            step={0.05}
            disabled={readOnly}
            format={(v) => v.toFixed(2)}
            leftLabel="Precise"
            rightLabel="Creative"
          />
        </Field>
      </div>
    </div>
  );
}
