import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-call-lagao-signature";
const TOLERANCE_MS = 5 * 60_000;

/** Signature = `v=<epoch ms>,d=<hex HMAC-SHA256(secret, body + ms)>` */
export function signWebhook(body: string, secret: string, timestamp = Date.now()): string {
  const digest = createHmac("sha256", secret).update(body + String(timestamp)).digest("hex");
  return `v=${timestamp},d=${digest}`;
}

export function verifyWebhook(body: string, secret: string, signature: string, now = Date.now()): boolean {
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > TOLERANCE_MS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body + m[1]).digest("hex"), "hex");
  const given = Buffer.from(m[2]!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
