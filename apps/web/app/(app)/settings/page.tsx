"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Page, useSession } from "@/components/app-shell";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  SecretReveal,
} from "@/components/ui";
import { type ApiKey, type Session, api } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";

function OrgCard() {
  const { org } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState(org.name);
  const [webhook, setWebhook] = useState(org.webhook_url ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [secretTitle, setSecretTitle] = useState("Webhook secret");
  const [confirmRotate, setConfirmRotate] = useState(false);

  useEffect(() => {
    setName(org.name);
    setWebhook(org.webhook_url ?? "");
  }, [org.name, org.webhook_url]);

  const save = useMutation({
    mutationFn: () => api.org.update({ name: name.trim(), webhook_url: webhook.trim() ? webhook.trim() : null }),
    onSuccess: (updated) => {
      qc.setQueryData<Session>(["session"], (s) => (s ? { ...s, org: { ...s.org, ...updated } } : s));
    },
  });
  const rotate = useMutation({
    mutationFn: api.org.rotateWebhookSecret,
    onSuccess: (r) => {
      setConfirmRotate(false);
      setSecretTitle("New webhook secret");
      setSecret(r.webhook_secret);
    },
  });

  const reveal = useMutation({
    mutationFn: api.org.getWebhookSecret,
    onSuccess: (r) => {
      setSecretTitle("Webhook secret");
      setSecret(r.webhook_secret);
    },
  });

  const dirty = name.trim() !== org.name || (webhook.trim() || null) !== (org.webhook_url ?? null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader title="Organization" description={<span className="font-mono">{org.org_id}</span>} />
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        <Field label="Organization name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label="Webhook URL"
          hint="Receives call_started, call_ended and call_analyzed events for every agent. Requests carry an x-call-lagao-signature header signed with your webhook secret."
        >
          <Input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://example.com/webhooks/call-lagao" type="url" />
        </Field>
        {save.error && <Alert>{save.error.message}</Alert>}
        {reveal.error && <Alert>{reveal.error.message}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" loading={reveal.isPending} onClick={() => reveal.mutate()}>
              <KeyRound className="size-4" /> Show webhook secret
            </Button>
            <Button type="button" onClick={() => (rotate.reset(), setConfirmRotate(true))}>
              <RotateCw className="size-4" /> Rotate webhook secret
            </Button>
          </div>
          <div className="flex items-center gap-3">
            {save.isSuccess && !dirty && <span className="text-xs text-emerald-300">Saved</span>}
            <Button type="submit" variant="primary" disabled={!dirty || !name.trim()} loading={save.isPending}>
              Save changes
            </Button>
          </div>
        </div>
        <p className="text-xs text-subtle">Concurrency limit: {org.concurrency_limit} simultaneous calls.</p>
      </form>

      <Modal
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="Rotate webhook secret?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={rotate.isPending} onClick={() => rotate.mutate()}>
              Rotate
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">The current secret stops working immediately. Update your webhook verifier with the new one.</p>
        {rotate.error && <Alert className="mt-3">{rotate.error.message}</Alert>}
      </Modal>
      <Modal open={!!secret} onClose={() => setSecret(null)} title={secretTitle} footer={<Button onClick={() => setSecret(null)}>Done</Button>}>
        {secret && <SecretReveal value={secret} />}
      </Modal>
    </Card>
  );
}

function ApiKeysCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null);

  const create = useMutation({
    mutationFn: (n: string) => api.apiKeys.create(n),
    onSuccess: (k) => {
      setCreateOpen(false);
      setCreated(k.api_key);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.apiKeys.revoke(id),
    onSuccess: () => {
      setToRevoke(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const openCreate = () => {
    setName("");
    create.reset();
    setCreateOpen(true);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="API keys"
        description="Use with Authorization: Bearer <key> for server-to-server calls."
        actions={
          <Button size="sm" variant="primary" onClick={openCreate}>
            <Plus className="size-3.5" /> Create key
          </Button>
        }
      />
      {keys.isPending ? (
        <LoadingState />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
      ) : keys.data.items.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-5" />} title="No API keys" description="Create a key to start calls from your backend." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-subtle">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Key</th>
                <th className="px-5 py-2.5 font-medium">Created</th>
                <th className="px-5 py-2.5 font-medium">Last used</th>
                <th className="w-12 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {keys.data.items.map((k) => (
                <tr key={k.key_id} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-2.5 font-medium">{k.name}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-muted">{k.key_prefix}…</td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-muted">{formatDateTime(k.created_timestamp)}</td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-muted">{k.last_used_timestamp ? relativeTime(k.last_used_timestamp) : "Never"}</td>
                  <td className="px-3 py-2.5 text-right">
                    <Button size="sm" variant="ghost" aria-label={`Revoke ${k.name}`} onClick={() => (revoke.reset(), setToRevoke(k))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="create-key" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </>
        }
      >
        <form
          id="create-key"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate(name.trim());
          }}
          className="space-y-3"
        >
          <Field label="Name" hint="Something to recognise it by, e.g. “production backend”.">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {create.error && <Alert>{create.error.message}</Alert>}
        </form>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="Your new API key" footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        {created && <SecretReveal value={created} note="Copy it now — for security we only store a hash and can't show it again." />}
      </Modal>

      <Modal
        open={!!toRevoke}
        onClose={() => setToRevoke(null)}
        title="Revoke API key?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setToRevoke(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={revoke.isPending} onClick={() => toRevoke && revoke.mutate(toRevoke.key_id)}>
              Revoke
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Requests using <span className="font-mono text-fg">{toRevoke?.key_prefix}…</span> ({toRevoke?.name}) will fail immediately.
        </p>
        {revoke.error && <Alert className="mt-3">{revoke.error.message}</Alert>}
      </Modal>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <Page narrow>
      <PageHeader title="Settings" description="Organization, webhooks and API keys." />
      <div className="space-y-6">
        <OrgCard />
        <ApiKeysCard />
      </div>
    </Page>
  );
}
