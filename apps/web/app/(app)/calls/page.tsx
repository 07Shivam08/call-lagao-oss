"use client";

import { CALL_STATUSES, type CallStatus } from "@call-lagao/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Globe, PhoneCall, PhoneIncoming, PhoneOutgoing, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Page } from "@/components/app-shell";
import { CallStatusBadge, isLiveStatus } from "@/components/call-status";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatCents, formatDateTime, formatDuration, formatMs, humanize } from "@/lib/format";

const PAGE_SIZE = 25;

export default function CallsPage() {
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState<CallStatus | "">("");
  // Stack of pagination keys: index 0 = first page (undefined key).
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const pageIndex = pages.length - 1;
  const paginationKey = pages[pageIndex];

  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents.list });
  const calls = useQuery({
    queryKey: ["calls", { agentId, status, paginationKey }],
    queryFn: () => api.calls.list({ limit: PAGE_SIZE, agent_id: agentId || undefined, status, pagination_key: paginationKey }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((c) => isLiveStatus(c.call_status)) ? 3000 : false),
  });

  const resetPaging = () => setPages([undefined]);
  const items = calls.data?.items ?? [];
  const anyLive = items.some((c) => isLiveStatus(c.call_status));

  return (
    <Page>
      <PageHeader
        title="Call History"
        description="Every web and phone call, with transcripts, latency and cost."
        actions={
          <>
            <div className="w-48">
              <Select
                aria-label="Filter by agent"
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  resetPaging();
                }}
              >
                <option value="">All agents</option>
                {agents.data?.items.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-40">
              <Select
                aria-label="Filter by status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as CallStatus | "");
                  resetPaging();
                }}
              >
                <option value="">All statuses</option>
                {CALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </div>
            <Button onClick={() => calls.refetch()} aria-label="Refresh" title="Refresh">
              <RefreshCw className={`size-4 ${calls.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />

      <Card className="overflow-hidden">
        {calls.isPending ? (
          <LoadingState />
        ) : calls.isError ? (
          <ErrorState error={calls.error} onRetry={() => calls.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<PhoneCall className="size-5" />}
            title={agentId || status ? "No calls match these filters" : "No calls yet"}
            description={agentId || status ? "Try clearing the filters." : "Open an agent and start a web call from the test panel to see it here."}
            action={
              !agentId && !status ? (
                <Button variant="primary" onClick={() => router.push("/agents")}>
                  Go to agents
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {anyLive && (
              <div className="flex items-center gap-2 border-b border-line bg-emerald-500/5 px-5 py-2 text-xs text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Live calls in progress — refreshing automatically.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-subtle">
                    <th className="whitespace-nowrap px-5 py-3 font-medium">Time</th>
                    <th className="px-5 py-3 font-medium">Agent</th>
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 text-right font-medium">Duration</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">Disconnection</th>
                    <th className="px-5 py-3 text-right font-medium">Cost</th>
                    <th className="whitespace-nowrap px-5 py-3 text-right font-medium">Latency p50</th>
                  </tr>
                </thead>
                <tbody className={calls.isPlaceholderData ? "opacity-60" : undefined}>
                  {items.map((c) => (
                    <tr
                      key={c.call_id}
                      onClick={() => router.push(`/calls/${c.call_id}`)}
                      className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-2"
                    >
                      <td className="whitespace-nowrap px-5 py-3 text-muted">{formatDateTime(c.start_timestamp ?? c.created_timestamp)}</td>
                      <td className="px-5 py-3">
                        <Link href={`/calls/${c.call_id}`} className="font-medium hover:text-violet-300" onClick={(e) => e.stopPropagation()}>
                          {c.agent_name ?? c.agent_id}
                        </Link>
                        <div className="text-[11px] text-subtle">v{c.agent_version}</div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-muted">
                        <span className="flex items-center gap-1.5">
                          {c.call_type === "web_call" ? (
                            <Globe className="size-3.5" />
                          ) : c.direction === "inbound" ? (
                            <PhoneIncoming className="size-3.5" />
                          ) : (
                            <PhoneOutgoing className="size-3.5" />
                          )}
                          {c.call_type === "web_call" ? "Web" : "Phone"}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <CallStatusBadge status={c.call_status} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-xs">{formatDuration(c.duration_ms)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-muted">{humanize(c.disconnection_reason)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-xs">{formatCents(c.call_cost?.combined_cost)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-right font-mono text-xs">{formatMs(c.latency?.e2e?.p50)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
              <span>Page {pageIndex + 1}</span>
              <div className="flex gap-2">
                <Button size="sm" disabled={pageIndex === 0} onClick={() => setPages((p) => p.slice(0, -1))}>
                  <ChevronLeft className="size-3.5" /> Previous
                </Button>
                <Button
                  size="sm"
                  disabled={!calls.data?.has_more || !calls.data.pagination_key}
                  onClick={() => calls.data?.pagination_key && setPages((p) => [...p, calls.data!.pagination_key!])}
                >
                  Next <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}
