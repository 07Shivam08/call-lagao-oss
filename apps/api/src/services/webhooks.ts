import { newId, type Call, type WebhookEvent } from "@call-lagao/shared";
import { SIGNATURE_HEADER, signWebhook } from "@call-lagao/shared/webhook";
import type { Db } from "../db.js";
import { assertPublicUrl } from "../netguard.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Default transport: refuses private destinations and never follows redirects (a redirect could point inward). */
const guardedFetch =
  (allowPrivate: boolean): FetchLike =>
  async (url, init) => {
    if (!allowPrivate) await assertPublicUrl(url);
    return fetch(url, { ...init, redirect: "manual" });
  };

export type WebhookOptions = { fetch?: FetchLike; backoffMs?: number[]; timeoutMs?: number; allowPrivateUrls?: boolean };

/**
 * Deliver one event to every configured URL (org-level + agent-level), signed with the org secret.
 * Retries 3 times with backoff; every attempt is logged in webhook_deliveries.
 */
export async function sendWebhooks(db: Db, orgId: string, event: WebhookEvent, call: Call, agentWebhookUrl: string | null, opts: WebhookOptions = {}) {
  const [org] = await db.query(`select webhook_url, webhook_secret from organizations where id = $1`, [orgId]);
  if (!org) return;
  const urls = [...new Set([org.webhook_url, agentWebhookUrl].filter((u): u is string => Boolean(u)))];
  if (!urls.length) return;

  const doFetch: FetchLike = opts.fetch ?? guardedFetch(opts.allowPrivateUrls ?? false);
  const backoff = opts.backoffMs ?? [0, 2000, 8000];
  const body = JSON.stringify({ event, call });

  await Promise.all(
    urls.map(async (url) => {
      for (let attempt = 1; attempt <= backoff.length; attempt++) {
        const wait = backoff[attempt - 1]!;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const t0 = Date.now();
        let status: number | null = null;
        let error: string | null = null;
        try {
          const res = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signWebhook(body, org.webhook_secret), "user-agent": "CallLagao-Webhook/1.0" },
            body,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          });
          status = res.status;
        } catch (e) {
          error = String((e as Error)?.message ?? e).slice(0, 500);
        }
        await db.query(
          `insert into webhook_deliveries (id, org_id, call_id, event, url, attempt, status_code, error, duration_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newId("whd"), orgId, call.call_id, event, url, attempt, status, error, Date.now() - t0],
        );
        if (status !== null && status >= 200 && status < 300) return;
      }
    }),
  );
}
