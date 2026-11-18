/**
 * Signed Pagination-Cursor (#T-008).
 *
 * Format: base64url(JSON({...payload, sig}))
 * sig = first 16 hex chars of HMAC-SHA256(secret, JSON(payload-without-sig))
 *
 * **Secret = WORKER_VERSION + GIT_COMMIT** — Worker-internal, nicht tenant-bound.
 * Reicht für Tampering-Detection; kein Authn-Replacement (Tenant-Filter kommt
 * separat).
 *
 * **Bewusste Deploy-Invalidation:** Cursors haben nur Pagination-Lifecycle (Sekunden
 * bis wenige Minuten). Bei einem Deploy verliert ein User max. eine Page-Position
 * und muss neu beginnen — akzeptabel und sogar wünschenswert (Schema-Drift-Schutz).
 * Das ist der Unterschied zu Invoice-Download-Tokens (siehe routes/invoices.ts),
 * die persistente Tenant-Secrets nutzen, weil dort 7-90d TTL einem Deploy nicht
 * geopfert werden darf.
 */
import { hmacSha256Hex } from "./crypto";
import { CodedError } from "../errors/catalog";
import type { Env } from "../env";

const SIG_LEN = 16;

function cursorSecret(env: Env): string {
  return `cursor:${env.WORKER_VERSION}:${env.GIT_COMMIT ?? "dev"}`;
}

export async function signCursor<T extends Record<string, unknown>>(env: Env, payload: T): Promise<string> {
  const json = JSON.stringify(payload);
  const sig = (await hmacSha256Hex(cursorSecret(env), json)).slice(0, SIG_LEN);
  const wrapped = JSON.stringify({ p: payload, s: sig });
  return base64UrlEncodeStr(wrapped);
}

export async function verifyCursor<T extends Record<string, unknown>>(env: Env, raw: string): Promise<T> {
  let decoded: { p?: T; s?: string };
  try {
    decoded = JSON.parse(base64UrlDecodeStr(raw)) as { p?: T; s?: string };
  } catch {
    throw new CodedError("GH-INPUT-001", { field: "cursor" });
  }
  if (!decoded.p || typeof decoded.s !== "string") {
    throw new CodedError("GH-INPUT-001", { field: "cursor" });
  }
  const expected = (await hmacSha256Hex(cursorSecret(env), JSON.stringify(decoded.p))).slice(0, SIG_LEN);
  if (!constantTimeEqual(expected, decoded.s)) {
    throw new CodedError("GH-INPUT-001", { field: "cursor", reason: "bad_signature" });
  }
  return decoded.p;
}

function base64UrlEncodeStr(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeStr(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return atob(b64);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
