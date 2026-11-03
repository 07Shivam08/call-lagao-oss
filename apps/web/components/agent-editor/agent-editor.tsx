"use client";

import { AgentConfig, LLM_MODELS } from "@call-lagao/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Eye, Rocket, Save } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, api, isApiError } from "@/lib/api";
import { extractVariables, relativeTime } from "@/lib/format";
import { Alert, Badge, Button, CopyButton, ErrorState, Field, Input, LoadingState, Modal, Select, cn } from "../ui";
import { PromptPane } from "./prompt-pane";
import { SettingsPane } from "./settings-pane";
import { TestPanel } from "./test-panel";

type SectionKey = "engine" | "voice" | "stt" | "turn" | "call" | "analysis";

/** Clean up transient editing artefacts before validation. */
function normalize(config: AgentConfig): AgentConfig {
  return {
    ...config,
    analysis: {
      ...config.analysis,
      fields: config.analysis.fields.map((f) => ({
        ...f,
        name: f.name.trim(),
        choices: f.type === "enum" ? (f.choices ?? []).map((c) => c.trim()).filter(Boolean) : undefined,
      })),
    },
    webhook_url: config.webhook_url?.trim() ? config.webhook_url.trim() : null,
  };
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "config"}: ${i.message}`);
}

export function AgentEditor({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [viewVersion, setViewVersion] = useState<number | null>(null);

  const agentQuery = useQuery({
    queryKey: ["agent", agentId, viewVersion ?? "latest"],
    queryFn: () => api.agents.get(agentId, viewVersion),
    staleTime: Infinity,
  });
  const versionsQuery = useQuery({ queryKey: ["agent-versions", agentId], queryFn: () => api.agents.versions(agentId) });
  const metaQuery = useQuery({ queryKey: ["meta-options"], queryFn: api.meta.options, staleTime: Infinity, retry: false });

  const agent = agentQuery.data;
  const [name, setName] = useState("");
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [baseline, setBaseline] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishTitle, setPublishTitle] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  // Reset the form whenever a different agent version (or a newer save) is loaded.
  const loadedKey = agent ? `${agent.agent_id}:${agent.version}:${agent.updated_timestamp}` : "";
  const lastKey = useRef("");
  useEffect(() => {
    if (!agent || loadedKey === lastKey.current) return;
    lastKey.current = loadedKey;
    const parsed = AgentConfig.safeParse(agent.config);
    const cfg = parsed.success ? parsed.data : agent.config;
    setName(agent.name);
    setConfig(cfg);
    setBaseline(JSON.stringify({ name: agent.name, config: cfg }));
    setIssues([]);
  }, [agent, loadedKey]);

  const dirty = config !== null && JSON.stringify({ name, config }) !== baseline;
  const readOnly = !!agent && agent.version !== agent.latest_version;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = setTimeout(() => setSavedFlash(false), 2000);
    return () => clearTimeout(t);
  }, [savedFlash]);

  const applyServerAgent = useCallback(
    (a: Agent) => {
      // Cached older versions carry a stale `latest_version`, so drop them.
      qc.removeQueries({ queryKey: ["agent", agentId], predicate: (q) => q.queryKey[2] !== "latest" });
      qc.setQueryData(["agent", agentId, "latest"], a);
      qc.invalidateQueries({ queryKey: ["agent-versions", agentId] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      setViewVersion(null);
    },
    [qc, agentId],
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<Agent> => {
      if (!config) throw new Error("Nothing to save");
      const parsed = AgentConfig.safeParse(normalize(config));
      if (!parsed.success) {
        const list = formatIssues(parsed.error);
        setIssues(list);
        throw new Error(`Fix ${list.length} validation issue${list.length === 1 ? "" : "s"} before saving.`);
      }
      if (!name.trim()) {
        setIssues(["name: Agent name is required"]);
        throw new Error("Agent name is required.");
      }
      setIssues([]);
      return api.agents.update(agentId, { name: name.trim(), config: parsed.data });
    },
    onSuccess: (a) => {
      applyServerAgent(a);
      setSavedFlash(true);
    },
  });

  const publishMutation = useMutation({
    mutationFn: async (title: string) => {
      if (dirty) await saveMutation.mutateAsync();
      return api.agents.publish(agentId, title.trim() || undefined);
    },
    onSuccess: (a) => {
      applyServerAgent(a);
      setPublishOpen(false);
    },
  });

  /** Used by the test panel: save if needed, then return the version to call. */
  const prepareTest = useCallback(async (): Promise<number> => {
    if (dirty && !readOnly) {
      const a = await saveMutation.mutateAsync();
      return a.version;
    }
    return agent?.version ?? 0;
  }, [dirty, readOnly, saveMutation, agent?.version]);

  const setSection = useCallback(<K extends SectionKey>(key: K, patch: Partial<AgentConfig[K]>) => {
    setConfig((c) => (c ? { ...c, [key]: { ...c[key], ...patch } } : c));
  }, []);
  const setWebhook = useCallback((url: string | null) => setConfig((c) => (c ? { ...c, webhook_url: url } : c)), []);

  const variables = useMemo(
    () => (config ? extractVariables(config.engine.prompt, config.engine.begin_message) : []),
    [config],
  );
  const models = metaQuery.data?.llm_models?.length ? metaQuery.data.llm_models : [...LLM_MODELS];

  if (agentQuery.isPending && !config) return <LoadingState label="Loading agent…" />;
  if (agentQuery.isError) {
    const notFound = isApiError(agentQuery.error) && agentQuery.error.status === 404;
    return (
      <div className="p-8">
        {notFound ? (
          <ErrorState error={new Error("This agent doesn't exist or was deleted.")} />
        ) : (
          <ErrorState error={agentQuery.error} onRetry={() => agentQuery.refetch()} />
        )}
      </div>
    );
  }
  if (!agent || !config) return <LoadingState label="Loading agent…" />;

  const versions = versionsQuery.data?.items ?? [];
  const versionOptions = versions.length
    ? [...versions].sort((a, b) => b.version - a.version)
    : [{ version: agent.latest_version, is_published: agent.published_version === agent.latest_version, title: null, base_version: null, updated_timestamp: agent.updated_timestamp }];

  return (
    <div className="flex flex-col xl:h-dvh">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-3 sm:px-5">
        <Link href="/agents" className="rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg" aria-label="Back to agents">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={readOnly}
              aria-label="Agent name"
              className="min-w-0 max-w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-base font-semibold hover:border-line focus:border-brand/60 focus:outline-none sm:w-auto"
              size={Math.max(8, Math.min(40, name.length + 2))}
            />
            {agent.is_published ? <Badge tone="green">Published</Badge> : <Badge tone="yellow">Draft</Badge>}
            {dirty && (
              <span className="flex items-center gap-1.5 text-xs text-amber-300">
                <span className="size-1.5 rounded-full bg-amber-400" /> Unsaved changes
              </span>
            )}
            {savedFlash && !dirty && (
              <span className="flex items-center gap-1 text-xs text-emerald-300">
                <Check className="size-3.5" /> Saved
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 pl-1.5 font-mono text-[11px] text-subtle">
            {agent.agent_id}
            <CopyButton value={agent.agent_id} className="h-5 px-1" />
            <span className="ml-1 font-sans">· updated {relativeTime(agent.updated_timestamp)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-52">
            <Select
              aria-label="Version"
              value={agent.version}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (dirty && !window.confirm("Discard unsaved changes?")) return;
                setViewVersion(v === agent.latest_version ? null : v);
              }}
            >
              {versionOptions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {v.is_published ? "published" : "draft"}
                  {v.title ? ` · ${v.title}` : ""}
                  {v.version === agent.latest_version ? " (latest)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <Button
            onClick={() => saveMutation.mutate()}
            loading={saveMutation.isPending && !publishMutation.isPending}
            disabled={readOnly || !dirty}
          >
            <Save className="size-4" /> Save
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              publishMutation.reset();
              setPublishTitle("");
              setPublishOpen(true);
            }}
            disabled={readOnly || (agent.is_published && !dirty)}
            title={agent.is_published && !dirty ? "This version is already published" : undefined}
          >
            <Rocket className="size-4" /> Publish
          </Button>
        </div>
      </header>

      {readOnly && (
        <div className="flex flex-wrap items-center gap-3 border-b border-sky-500/20 bg-sky-500/10 px-5 py-2 text-sm text-sky-100">
          <Eye className="size-4" />
          Viewing v{agent.version}
          {agent.is_published ? " (published)" : ""} — read-only. Edit the latest version to make changes.
          <Button size="sm" onClick={() => setViewVersion(null)}>
            Go to latest (v{agent.latest_version})
          </Button>
        </div>
      )}
      {(saveMutation.error || issues.length > 0) && (
        <div className="border-b border-line px-5 py-3">
          <Alert>
            <div className="font-medium">{saveMutation.error?.message ?? "Validation failed"}</div>
            {issues.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}

      {/* 3 panes */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(340px,400px)]">
        <div className="min-h-0 border-b border-line bg-panel/40 xl:overflow-y-auto xl:border-b-0 xl:border-r lg:border-r">
          <PromptPane
            engine={config.engine}
            onChange={(patch) => setSection("engine", patch)}
            readOnly={readOnly}
            models={models}
            variables={variables}
          />
        </div>
        <div className={cn("min-h-0 border-b border-line bg-panel/40 xl:overflow-y-auto xl:border-b-0 xl:border-r")}>
          <SettingsPane config={config} setSection={setSection} setWebhook={setWebhook} readOnly={readOnly} meta={metaQuery.data} />
        </div>
        <div className="min-h-[520px] bg-panel lg:col-span-2 xl:col-span-1 xl:min-h-0 xl:overflow-hidden">
          <TestPanel
            agentId={agentId}
            variables={variables}
            prepare={prepareTest}
            dirty={dirty}
            readOnly={readOnly}
            viewedVersion={agent.version}
          />
        </div>
      </div>

      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title={`Publish v${agent.is_published ? agent.latest_version + 1 : agent.version}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={publishMutation.isPending} onClick={() => publishMutation.mutate(publishTitle)}>
              <Rocket className="size-4" /> {dirty ? "Save & publish" : "Publish"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Published versions are immutable. API and phone calls use the latest published version unless a version is specified;
            further edits create a new draft.
          </p>
          <Field label="Version title (optional)">
            <Input value={publishTitle} onChange={(e) => setPublishTitle(e.target.value)} placeholder="e.g. Friendlier greeting" autoFocus />
          </Field>
          {publishMutation.error && <Alert>{publishMutation.error.message}</Alert>}
        </div>
      </Modal>
    </div>
  );
}
