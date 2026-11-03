"use client";

import type { Call, Distribution, TranscriptItem } from "@call-lagao/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ChevronRight, PhoneOff, Wrench, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { Page } from "@/components/app-shell";
import { CallStatusBadge, isLiveStatus } from "@/components/call-status";
import { Alert, Badge, Button, Card, CardHeader, CopyButton, EmptyState, ErrorState, LoadingState, cn } from "@/components/ui";
import { api, isApiError } from "@/lib/api";
import { formatCents, formatDateTime, formatDuration, formatMs, humanize } from "@/lib/format";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function msLabel(ms?: number) {
  if (ms === undefined) return null;
  return <span className="font-mono text-[10px] text-subtle">{formatDuration(ms)}</span>;
}

function ToolChip({
  item,
  result,
}: {
  item: Extract<TranscriptItem, { role: "tool_call_invocation" }>;
  result?: Extract<TranscriptItem, { role: "tool_call_result" }>;
}) {
  return (
    <details className="group mx-auto w-full max-w-[90%] rounded-lg border border-line bg-panel-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <ChevronRight className="size-3.5 text-subtle transition-transform group-open:rotate-90" />
        <Wrench className="size-3.5 text-violet-300" />
        <span className="font-mono">{item.name}</span>
        {result ? (
          result.successful ? (
            <Badge tone="green">success</Badge>
          ) : (
            <Badge tone="red">failed</Badge>
          )
        ) : (
          <Badge>no result</Badge>
        )}
        <span className="ml-auto">{msLabel(item.time_ms)}</span>
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-2">
        <div>
          <div className="mb-1 text-[11px] text-subtle">Arguments</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg p-2 font-mono text-[11px] text-muted">{prettyJson(item.arguments)}</pre>
        </div>
        {result && (
          <div>
            <div className="mb-1 text-[11px] text-subtle">Result</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-2 font-mono text-[11px] text-muted">
              {prettyJson(result.content)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function Transcript({ items }: { items: TranscriptItem[] }) {
  const results = new Map<string, Extract<TranscriptItem, { role: "tool_call_result" }>>();
  const invoked = new Set<string>();
  for (const t of items) {
    if (t.role === "tool_call_result") results.set(t.tool_call_id, t);
    if (t.role === "tool_call_invocation") invoked.add(t.tool_call_id);
  }
  if (!items.length) return <EmptyState title="No transcript" description="Nothing was said on this call (yet)." />;
  return (
    <div className="space-y-3 p-5">
      {items.map((t, i) => {
        if (t.role === "tool_call_invocation") return <ToolChip key={i} item={t} result={results.get(t.tool_call_id)} />;
        if (t.role === "tool_call_result") {
          if (invoked.has(t.tool_call_id)) return null; // rendered with its invocation
          return (
            <div key={i} className="mx-auto max-w-[90%] rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] text-muted">
              result ({t.tool_call_id}): {t.content}
            </div>
          );
        }
        const isUser = t.role === "user";
        return (
          <div key={i} className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
            <div className="flex items-center gap-2 px-1 text-[11px] text-subtle">
              {isUser ? "User" : "Agent"} {msLabel(t.start_ms)}
              {t.role === "agent" && t.interrupted && <Badge tone="yellow">interrupted</Badge>}
            </div>
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                isUser ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-elevated",
              )}
            >
              {t.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LatencyTable({ latency }: { latency: Call["latency"] }) {
  const rows: [string, string, Distribution | undefined][] = [
    ["e2e", "End-to-end", latency?.e2e],
    ["llm", "LLM (TTFT)", latency?.llm],
    ["tts", "TTS (TTFB)", latency?.tts],
    ["stt", "STT", latency?.stt],
  ];
  if (!rows.some(([, , d]) => d)) return <p className="px-5 py-6 text-sm text-subtle">No latency samples recorded.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-subtle">
          <th className="px-5 py-2.5 font-medium">Stage</th>
          <th className="px-3 py-2.5 text-right font-medium">p50</th>
          <th className="px-3 py-2.5 text-right font-medium">p90</th>
          <th className="px-3 py-2.5 text-right font-medium">max</th>
          <th className="px-5 py-2.5 text-right font-medium">n</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, label, d]) => (
          <tr key={k} className="border-b border-line/60 last:border-0">
            <td className="px-5 py-2.5">{label}</td>
            <td className="px-3 py-2.5 text-right font-mono text-xs">{formatMs(d?.p50)}</td>
            <td className="px-3 py-2.5 text-right font-mono text-xs">{formatMs(d?.p90)}</td>
            <td className="px-3 py-2.5 text-right font-mono text-xs">{formatMs(d?.max)}</td>
            <td className="px-5 py-2.5 text-right font-mono text-xs text-subtle">{d?.num ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostTable({ cost }: { cost: Call["call_cost"] }) {
  if (!cost) return <p className="px-5 py-6 text-sm text-subtle">Cost is computed when the call ends.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs text-subtle">
          <th className="px-5 py-2.5 font-medium">Product</th>
          <th className="px-3 py-2.5 text-right font-medium">Quantity</th>
          <th className="px-5 py-2.5 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {cost.product_costs.map((p) => (
          <tr key={p.product} className="border-b border-line/60">
            <td className="px-5 py-2.5">{humanize(p.product)}</td>
            <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs text-muted">
              {p.quantity} {p.unit === "1k_tokens" ? "k tokens" : p.unit === "second" ? "s" : "call"}
            </td>
            <td className="px-5 py-2.5 text-right font-mono text-xs">{formatCents(p.cost)}</td>
          </tr>
        ))}
        <tr>
          <td className="px-5 py-2.5 font-medium">Total</td>
          <td className="px-3 py-2.5 text-right font-mono text-xs text-muted">{formatDuration(cost.total_duration_seconds * 1000)}</td>
          <td className="px-5 py-2.5 text-right font-mono text-sm font-semibold">{formatCents(cost.combined_cost)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function VarTable({ vars, empty }: { vars: Record<string, unknown>; empty: string }) {
  const entries = Object.entries(vars ?? {});
  if (!entries.length) return <p className="text-sm text-subtle">{empty}</p>;
  return (
    <dl className="divide-y divide-line/60 rounded-lg border border-line">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-3 px-3 py-2 text-sm">
          <dt className="w-2/5 shrink-0 truncate font-mono text-xs text-muted">{k}</dt>
          <dd className="min-w-0 flex-1 break-words">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const SENTIMENT_TONE = { Positive: "green", Neutral: "neutral", Negative: "red", Unknown: "neutral" } as const;

export default function CallDetailPage() {
  const { callId } = useParams<{ callId: string }>();
  const qc = useQueryClient();
  const call = useQuery({
    queryKey: ["call", callId],
    queryFn: () => api.calls.get(callId),
    refetchInterval: (q) => {
      const c = q.state.data;
      if (!c) return false;
      if (isLiveStatus(c.call_status)) return 3000;
      // Post-call analysis lands shortly after the call ends.
      if (c.call_status === "ended" && !c.call_analysis && c.end_timestamp && Date.now() - c.end_timestamp < 3 * 60_000) return 4000;
      return false;
    },
  });
  const stop = useMutation({
    mutationFn: () => api.calls.stop(callId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["call", callId] }),
  });

  if (call.isPending) return <LoadingState label="Loading call…" />;
  if (call.isError) {
    return (
      <Page>
        <ErrorState
          error={isApiError(call.error) && call.error.status === 404 ? new Error("Call not found.") : call.error}
          onRetry={() => call.refetch()}
        />
      </Page>
    );
  }
  const c = call.data;
  const analysis = c.call_analysis;

  return (
    <Page>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href="/calls" className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label="Back to calls">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{c.agent_name ?? c.agent_id}</h1>
            <CallStatusBadge status={c.call_status} />
            <Badge>{c.call_type === "web_call" ? "Web call" : `Phone · ${c.direction ?? "outbound"}`}</Badge>
          </div>
          <div className="flex items-center gap-1 font-mono text-xs text-subtle">
            {c.call_id} <CopyButton value={c.call_id} className="h-5 px-1" />
          </div>
        </div>
        {isLiveStatus(c.call_status) && (
          <Button variant="danger" onClick={() => stop.mutate()} loading={stop.isPending}>
            <PhoneOff className="size-4" /> End call
          </Button>
        )}
      </div>
      {stop.error && <Alert className="mb-4">{stop.error.message}</Alert>}

      <Card className="mb-5 grid grid-cols-2 gap-x-6 gap-y-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Started">{formatDateTime(c.start_timestamp)}</Fact>
        <Fact label="Ended">{formatDateTime(c.end_timestamp)}</Fact>
        <Fact label="Duration">{formatDuration(c.duration_ms)}</Fact>
        <Fact label="Cost">{formatCents(c.call_cost?.combined_cost)}</Fact>
        <Fact label="Latency p50">{formatMs(c.latency?.e2e?.p50)}</Fact>
        <Fact label="Disconnection">{humanize(c.disconnection_reason)}</Fact>
        <Fact label="Agent version">
          <Link href={`/agents/${c.agent_id}`} className="text-violet-300 hover:underline">
            v{c.agent_version}
          </Link>
        </Fact>
        {c.call_type === "phone_call" && (
          <>
            <Fact label="From">{c.from_number ?? "—"}</Fact>
            <Fact label="To">{c.to_number ?? "—"}</Fact>
          </>
        )}
        <Fact label="Created">{formatDateTime(c.created_timestamp)}</Fact>
      </Card>

      {c.recording_url && (
        <Card className="mb-5 p-4">
          <audio controls src={c.recording_url} className="w-full" />
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader title="Transcript" description={isLiveStatus(c.call_status) ? "The full transcript is available when the call ends." : undefined} />
          <Transcript items={c.transcript ?? []} />
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Analysis" description={!analysis && c.call_status === "ended" ? "Running post-call analysis…" : undefined} />
            {analysis ? (
              <div className="space-y-4 p-5">
                <div className="flex flex-wrap gap-2">
                  {analysis.call_successful ? (
                    <Badge tone="green">
                      <CheckCircle2 className="size-3" /> Successful
                    </Badge>
                  ) : (
                    <Badge tone="red">
                      <XCircle className="size-3" /> Unsuccessful
                    </Badge>
                  )}
                  <Badge tone={SENTIMENT_TONE[analysis.user_sentiment] ?? "neutral"}>Sentiment: {analysis.user_sentiment}</Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted">{analysis.call_summary || "No summary."}</p>
                {Object.keys(analysis.custom_analysis_data ?? {}).length > 0 && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium text-muted">Custom fields</div>
                    <VarTable vars={analysis.custom_analysis_data} empty="" />
                  </div>
                )}
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-subtle">
                {c.call_status === "ended" ? "Analysis will appear here shortly." : "Analysis runs after the call ends."}
              </p>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Latency" description="Per-turn distributions" />
            <LatencyTable latency={c.latency} />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Cost" />
            <CostTable cost={c.call_cost} />
          </Card>

          <Card>
            <CardHeader title="Variables" />
            <div className="space-y-4 p-5">
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">Dynamic variables</div>
                <VarTable vars={c.dynamic_variables} empty="None passed." />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted">Collected variables</div>
                <VarTable vars={c.collected_variables} empty="None collected." />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Metadata" actions={<CopyButton value={JSON.stringify(c.metadata ?? {}, null, 2)} />} />
            <pre className="overflow-x-auto p-5 font-mono text-xs text-muted">{JSON.stringify(c.metadata ?? {}, null, 2)}</pre>
          </Card>
        </div>
      </div>
    </Page>
  );
}
