"use client";

import type { AnalysisField } from "@call-lagao/shared";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Select } from "../ui";

const TYPES: AnalysisField["type"][] = ["string", "boolean", "number", "enum"];

export function AnalysisEditor({
  fields,
  onChange,
  readOnly,
}: {
  fields: AnalysisField[];
  onChange: (fields: AnalysisField[]) => void;
  readOnly: boolean;
}) {
  const update = (i: number, patch: Partial<AnalysisField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-subtle">
        After every call the transcript is analysed for a summary, success and sentiment. Add custom fields to extract structured
        data (e.g. <code className="font-mono">appointment_date</code>, <code className="font-mono">interested</code>).
      </p>
      {fields.map((f, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
          <div className="flex gap-2">
            <Input
              value={f.name}
              readOnly={readOnly}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="field_name"
              className="font-mono text-xs"
            />
            <div className="w-32 shrink-0">
              <Select
                value={f.type}
                disabled={readOnly}
                onChange={(e) => {
                  const type = e.target.value as AnalysisField["type"];
                  update(i, { type, choices: type === "enum" ? (f.choices ?? []) : undefined });
                }}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            {!readOnly && (
              <Button size="sm" variant="ghost" className="h-9" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label="Remove field">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <Input
            value={f.description}
            readOnly={readOnly}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="What should the analyser extract?"
            className="text-xs"
          />
          {f.type === "enum" && (
            <Input
              value={(f.choices ?? []).join(",")}
              readOnly={readOnly}
              onChange={(e) => update(i, { choices: e.target.value.split(",") })}
              placeholder="Choices, comma separated: hot, warm, cold"
              className="text-xs"
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button size="sm" onClick={() => onChange([...fields, { name: "", type: "string", description: "" }])}>
          <Plus className="size-3.5" /> Add field
        </Button>
      )}
    </div>
  );
}
