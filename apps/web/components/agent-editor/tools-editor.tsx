"use client";

import { CustomTool, type Tool } from "@call-lagao/shared";
import { Pencil, Plus, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Field, Input, KeyValueEditor, Modal, Select, Switch, Textarea } from "../ui";

type CustomToolT = Extract<Tool, { type: "custom" }>;
type EndCallToolT = Extract<Tool, { type: "end_call" }>;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const DEFAULT_END_CALL: EndCallToolT = {
  type: "end_call",
  name: "end_call",
  description: "End the call when the conversation is complete or the user asks to hang up.",
};

const EXAMPLE_PARAMS = JSON.stringify(
  {
    type: "object",
    properties: {
      date: { type: "string", description: "Requested date, YYYY-MM-DD" },
      party_size: { type: "integer", description: "Number of guests" },
    },
    required: ["date"],
  },
  null,
  2,
);

type Draft = {
  name: string;
  description: string;
  url: string;
  method: (typeof METHODS)[number];
  headers: [string, string][];
  parameters: string;
  timeout_s: number;
  speak_during_execution: boolean;
  execution_message: string;
};

const toDraft = (t?: CustomToolT): Draft => ({
  name: t?.name ?? "",
  description: t?.description ?? "",
  url: t?.url ?? "",
  method: t?.method ?? "POST",
  headers: Object.entries(t?.headers ?? {}),
  parameters: t ? JSON.stringify(t.parameters, null, 2) : JSON.stringify({ type: "object", properties: {} }, null, 2),
  timeout_s: Math.round((t?.timeout_ms ?? 10_000) / 1000),
  speak_during_execution: t?.speak_during_execution ?? false,
  execution_message: t?.execution_message ?? "",
});

function parseDraft(d: Draft, otherNames: string[]): { tool?: CustomToolT; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  let parameters: unknown;
  try {
    parameters = JSON.parse(d.parameters || "{}");
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      errors.parameters = "Must be a JSON object.";
    } else if ((parameters as { type?: unknown }).type !== "object") {
      errors.parameters = 'Top-level schema must have "type": "object".';
    }
  } catch (e) {
    errors.parameters = `Invalid JSON: ${(e as Error).message}`;
  }
  if (otherNames.includes(d.name)) errors.name = "Another tool already uses this name.";

  const candidate = {
    type: "custom" as const,
    name: d.name.trim(),
    description: d.description.trim(),
    url: d.url.trim(),
    method: d.method,
    headers: Object.fromEntries(d.headers.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
    parameters,
    timeout_ms: Math.round(d.timeout_s * 1000),
    speak_during_execution: d.speak_during_execution,
    execution_message: d.speak_during_execution && d.execution_message.trim() ? d.execution_message.trim() : undefined,
  };
  const res = CustomTool.safeParse(candidate);
  if (!res.success) {
    for (const issue of res.error.issues) {
      const key = String(issue.path[0] ?? "form");
      const mapped = key === "timeout_ms" ? "timeout_s" : key;
      if (!errors[mapped]) errors[mapped] = issue.message;
    }
  }
  if (Object.keys(errors).length || !res.success) return { errors };
  return { tool: res.data, errors };
}

export function ToolsEditor({
  tools,
  onChange,
  readOnly,
}: {
  tools: Tool[];
  onChange: (tools: Tool[]) => void;
  readOnly: boolean;
}) {
  const endCall = tools.find((t): t is EndCallToolT => t.type === "end_call");
  const custom = tools.filter((t): t is CustomToolT => t.type === "custom");
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const setEndCall = (enabled: boolean) => {
    const rest = tools.filter((t) => t.type !== "end_call");
    onChange(enabled ? [endCall ?? DEFAULT_END_CALL, ...rest] : rest);
  };

  const open = (index: number | null) => {
    setErrors({});
    setEditing({ index, draft: toDraft(index === null ? undefined : custom[index]) });
  };

  const save = () => {
    if (!editing) return;
    const otherNames = [
      ...(endCall ? [endCall.name] : []),
      ...custom.filter((_, i) => i !== editing.index).map((t) => t.name),
    ];
    const { tool, errors: errs } = parseDraft(editing.draft, otherNames);
    setErrors(errs);
    if (!tool) return;
    const nextCustom = editing.index === null ? [...custom, tool] : custom.map((t, i) => (i === editing.index ? tool : t));
    onChange([...(endCall ? [endCall] : []), ...nextCustom]);
    setEditing(null);
  };

  const remove = (index: number) => {
    onChange([...(endCall ? [endCall] : []), ...custom.filter((_, i) => i !== index)]);
  };

  const d = editing?.draft;
  const setD = (patch: Partial<Draft>) => editing && setEditing({ ...editing, draft: { ...editing.draft, ...patch } });

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
        <div>
          <div className="text-sm font-medium">End call</div>
          <p className="text-xs text-subtle">Lets the agent hang up when the conversation is done or the user asks.</p>
        </div>
        <Switch checked={!!endCall} onChange={setEndCall} disabled={readOnly} label="End call tool" />
      </div>

      {custom.map((t, i) => (
        <div key={`${t.name}-${i}`} className="flex items-start gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5">
          <Webhook className="mt-0.5 size-4 shrink-0 text-violet-300" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-sm">{t.name}</span>
              <Badge>{t.method}</Badge>
              {t.speak_during_execution && <Badge tone="blue">speaks while running</Badge>}
            </div>
            <p className="truncate text-xs text-subtle">{t.url}</p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description}</p>
          </div>
          <div className="flex shrink-0 gap-0.5">
            <Button size="sm" variant="ghost" onClick={() => open(i)} aria-label={`Edit ${t.name}`}>
              <Pencil className="size-3.5" />
            </Button>
            {!readOnly && (
              <Button size="sm" variant="ghost" onClick={() => remove(i)} aria-label={`Remove ${t.name}`}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      ))}

      {!readOnly && (
        <Button size="sm" onClick={() => open(null)}>
          <Plus className="size-3.5" /> Add custom tool
        </Button>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        wide
        title={editing?.index === null ? "Add custom tool" : readOnly ? "View tool" : "Edit custom tool"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button variant="primary" onClick={save}>
                {editing?.index === null ? "Add tool" : "Update tool"}
              </Button>
            )}
          </>
        }
      >
        {d && (
          <fieldset disabled={readOnly} className="space-y-4">
            <p className="text-xs leading-relaxed text-subtle">
              When the LLM calls this tool, the voice worker sends an HTTP request to your URL with the arguments the model
              produced and feeds the response back to the model.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" error={errors.name} hint="Letters, digits and underscores.">
                <Input value={d.name} onChange={(e) => setD({ name: e.target.value })} placeholder="check_availability" className="font-mono" />
              </Field>
              <Field label="Method" error={errors.method}>
                <Select value={d.method} onChange={(e) => setD({ method: e.target.value as Draft["method"] })}>
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Description" error={errors.description} hint="Tell the LLM when and why to call this tool.">
              <Textarea
                value={d.description}
                onChange={(e) => setD({ description: e.target.value })}
                rows={2}
                placeholder="Check table availability for a given date and party size."
              />
            </Field>
            <Field label="URL" error={errors.url}>
              <Input value={d.url} onChange={(e) => setD({ url: e.target.value })} placeholder="https://api.example.com/availability" />
            </Field>
            <Field label="Headers" error={errors.headers}>
              <KeyValueEditor
                value={d.headers}
                onChange={(headers) => setD({ headers })}
                disabled={readOnly}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer …"
                addLabel="Add header"
              />
            </Field>
            <Field
              label="Parameters (JSON Schema)"
              error={errors.parameters}
              right={
                !readOnly && (
                  <button type="button" className="text-xs text-violet-300 hover:underline" onClick={() => setD({ parameters: EXAMPLE_PARAMS })}>
                    Insert example
                  </button>
                )
              }
              hint='An object schema describing the arguments, e.g. {"type":"object","properties":{…},"required":[…]}.'
            >
              <Textarea
                value={d.parameters}
                onChange={(e) => setD({ parameters: e.target.value })}
                rows={8}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Timeout (seconds)" error={errors.timeout_s} hint="1–120 seconds.">
              <Input
                type="number"
                min={1}
                max={120}
                value={d.timeout_s}
                onChange={(e) => setD({ timeout_s: Number(e.target.value) })}
                className="w-32"
              />
            </Field>
            <div className="space-y-3 rounded-lg border border-line bg-panel-2 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Speak during execution</div>
                  <p className="text-xs text-subtle">Say a short filler line while the request runs so the caller isn&apos;t left in silence.</p>
                </div>
                <Switch
                  checked={d.speak_during_execution}
                  onChange={(v) => setD({ speak_during_execution: v })}
                  disabled={readOnly}
                  label="Speak during execution"
                />
              </div>
              {d.speak_during_execution && (
                <Field label="Execution message" error={errors.execution_message}>
                  <Input
                    value={d.execution_message}
                    onChange={(e) => setD({ execution_message: e.target.value })}
                    placeholder="One moment while I check that for you…"
                  />
                </Field>
              )}
            </div>
            {errors.form && <Alert>{errors.form}</Alert>}
          </fieldset>
        )}
      </Modal>
    </div>
  );
}
