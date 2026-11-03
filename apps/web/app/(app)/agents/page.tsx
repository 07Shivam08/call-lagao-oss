"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Page } from "@/components/app-shell";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader } from "@/components/ui";
import { type AgentSummary, api } from "@/lib/api";
import { humanize, relativeTime } from "@/lib/format";

function VersionBadge({ a }: { a: AgentSummary }) {
  if (a.published_version === null) return <Badge tone="yellow">Draft v{a.latest_version}</Badge>;
  if (a.published_version === a.latest_version) return <Badge tone="green">Published v{a.published_version}</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone="green">Published v{a.published_version}</Badge>
      <Badge tone="yellow">Draft v{a.latest_version}</Badge>
    </span>
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [toDelete, setToDelete] = useState<AgentSummary | null>(null);

  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents.list });

  const create = useMutation({
    mutationFn: (n: string) => api.agents.create({ name: n }),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      router.push(`/agents/${agent.agent_id}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.agents.remove(id),
    onSuccess: () => {
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  const openCreate = () => {
    setName("");
    create.reset();
    setCreateOpen(true);
  };

  return (
    <Page>
      <PageHeader
        title="Agents"
        description="Voice agents with versioned prompts, voices and tools."
        actions={
          <Button variant="primary" onClick={openCreate}>
            <Plus className="size-4" /> Create agent
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {agents.isPending ? (
          <LoadingState />
        ) : agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
        ) : agents.data.items.length === 0 ? (
          <EmptyState
            icon={<Bot className="size-5" />}
            title="No agents yet"
            description="Create your first agent, write a prompt, pick a voice and test it right in the browser."
            action={
              <Button variant="primary" onClick={openCreate}>
                <Plus className="size-4" /> Create agent
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-subtle">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Voice</th>
                  <th className="px-5 py-3 font-medium">Version</th>
                  <th className="px-5 py-3 font-medium">Updated</th>
                  <th className="w-10 px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {agents.data.items.map((a) => (
                  <tr
                    key={a.agent_id}
                    className="group cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-2"
                    onClick={() => router.push(`/agents/${a.agent_id}`)}
                  >
                    <td className="px-5 py-3">
                      <Link href={`/agents/${a.agent_id}`} className="font-medium hover:text-violet-300" onClick={(e) => e.stopPropagation()}>
                        {a.name}
                      </Link>
                      <div className="font-mono text-[11px] text-subtle">{a.agent_id}</div>
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted">{a.model}</td>
                    <td className="px-5 py-3 text-muted">{humanize(a.voice_provider)}</td>
                    <td className="px-5 py-3">
                      <VersionBadge a={a} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-muted">{relativeTime(a.updated_timestamp)}</td>
                    <td className="px-3 py-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                        aria-label={`Delete ${a.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          remove.reset();
                          setToDelete(a);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create agent"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-agent" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <form id="create-agent" onSubmit={onCreate} className="space-y-3">
          <Field label="Agent name" hint="You can change the prompt, voice and everything else in the editor.">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Restaurant booking assistant" />
          </Field>
          {create.error && <Alert>{create.error.message}</Alert>}
        </form>
      </Modal>

      <Modal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete agent?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.agent_id)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">{toDelete?.name}</span> will be removed. Existing call history is kept.
        </p>
        {remove.error && <Alert className="mt-3">{remove.error.message}</Alert>}
      </Modal>
    </Page>
  );
}
