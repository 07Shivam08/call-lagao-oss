import type { AgentConfig, AgentConfigInput, Call, CallStatus } from "@call-lagao/shared";

// ---------------------------------------------------------------------------
// Types (service contract §1, apps/api/README.md)
// ---------------------------------------------------------------------------

export type User = { user_id: string; email: string; name: string | null };
export type Org = { org_id: string; name: string; webhook_url: string | null; concurrency_limit: number };
export type Session = { user: User; org: Org };

export type ApiKey = {
  key_id: string;
  name: string;
  key_prefix: string;
  created_timestamp: number;
  last_used_timestamp: number | null;
};
export type CreatedApiKey = { key_id: string; name: string; api_key: string };

export type AgentSummary = {
  agent_id: string;
  name: string;
  latest_version: number;
  published_version: number | null;
  updated_timestamp: number;
  voice_provider: string;
  model: string;
};

export type Agent = {
  agent_id: string;
  name: string;
  version: number;
  base_version: number | null;
  is_published: boolean;
  title: string | null;
  latest_version: number;
  published_version: number | null;
  config: AgentConfig;
  created_timestamp: number;
  updated_timestamp: number;
};

export type AgentVersion = {
  version: number;
  base_version: number | null;
  is_published: boolean;
  title: string | null;
  updated_timestamp: number;
};

export type List<T> = { items: T[]; has_more?: boolean; pagination_key?: string | null };

export type CreateWebCallResponse = { call_id: string; access_token: string; livekit_url: string; call: Call };

export type MetaOptions = {
  llm_models: string[];
  tts_providers: string[];
  voices: { provider: string; voice_id: string; name: string }[];
  stt_languages: string[];
};

export type ListCallsParams = {
  limit?: number;
  pagination_key?: string;
  agent_id?: string;
  status?: CallStatus | "";
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** Statuses the API uses when voice (LiveKit / SIP) isn't configured. */
export const isNotConfigured = (e: unknown) =>
  isApiError(e) && (e.status === 501 || e.status === 503 || e.code === "not_configured");

type ErrorBody = { error?: { code?: string; message?: string } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the API. Is it running?");
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  const err = (data as ErrorBody | undefined)?.error;
  if (!res.ok || (err && typeof err === "object")) {
    const fallback =
      res.status === 500 && !text
        ? "The API is unreachable (proxy error). Is it running on :4000?"
        : res.statusText || `Request failed (${res.status})`;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? fallback);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  auth: {
    signup: (body: { email: string; password: string; name?: string; org_name?: string }) =>
      request<{ user: User; org: Org }>("POST", "/auth/signup", body),
    login: (body: { email: string; password: string }) => request<{ user: User; org: Org }>("POST", "/auth/login", body),
    logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  },
  session: () => request<Session>("GET", "/session"),

  org: {
    update: (body: { name?: string; webhook_url?: string | null }) => request<Org>("PATCH", "/org", body),
    rotateWebhookSecret: () => request<{ webhook_secret: string }>("POST", "/org/webhook-secret", {}),
  },

  apiKeys: {
    list: () => request<List<ApiKey>>("GET", "/api-keys"),
    create: (name: string) => request<CreatedApiKey>("POST", "/api-keys", { name }),
    revoke: (keyId: string) => request<{ ok: true }>("DELETE", `/api-keys/${encodeURIComponent(keyId)}`),
  },

  agents: {
    list: () => request<List<AgentSummary>>("GET", "/agents"),
    create: (body: { name: string; config?: AgentConfigInput }) => request<Agent>("POST", "/agents", body),
    get: (agentId: string, version?: number | null) =>
      request<Agent>("GET", `/agents/${encodeURIComponent(agentId)}${qs({ version })}`),
    update: (agentId: string, body: { name?: string; config?: AgentConfigInput }) =>
      request<Agent>("PATCH", `/agents/${encodeURIComponent(agentId)}`, body),
    remove: (agentId: string) => request<{ ok: true }>("DELETE", `/agents/${encodeURIComponent(agentId)}`),
    versions: (agentId: string) => request<List<AgentVersion>>("GET", `/agents/${encodeURIComponent(agentId)}/versions`),
    publish: (agentId: string, title?: string) =>
      request<Agent>("POST", `/agents/${encodeURIComponent(agentId)}/publish`, title ? { title } : {}),
  },

  calls: {
    createWeb: (body: {
      agent_id: string;
      agent_version?: number;
      dynamic_variables?: Record<string, string>;
      metadata?: Record<string, unknown>;
    }) => request<CreateWebCallResponse>("POST", "/calls/web", body),
    list: (params: ListCallsParams = {}) =>
      request<List<Call>>(
        "GET",
        `/calls${qs({ limit: params.limit, pagination_key: params.pagination_key, agent_id: params.agent_id, status: params.status })}`,
      ),
    get: (callId: string) => request<Call>("GET", `/calls/${encodeURIComponent(callId)}`),
    stop: (callId: string) => request<{ ok: true }>("POST", `/calls/${encodeURIComponent(callId)}/stop`, {}),
  },

  meta: {
    options: () => request<MetaOptions>("GET", "/meta/options"),
  },
};
