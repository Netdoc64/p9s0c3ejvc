import { hmacSha256Hex } from "../lib/crypto";

const encoder = new TextEncoder();

export interface JwtPayload {
  iss: string;          // tenant-spezifisch: tenants:<tenant_id>
  sub: string;          // customer_id
  aud: string;          // "grosshandel.api"
  exp: number;          // unix-seconds
  iat: number;
  scope: string[];
  tenant_id: string;
  jti?: string;
}

/**
 * Secret-Selektor für Doppel-Reader bei Rotation (#A-005).
 *
 * `kid` im Header: "current" für mit aktuellem Secret signiert, "previous" optional.
 * Bei Rotation hat verifyJwt `currentSecret` + optional `previousSecret`. Verify
 * versucht beide, damit outstanding Tokens 7d Karenz weiterleben.
 */
export interface JwtSecretSet {
  current: string;
  previous?: string;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlString(s: string): string {
  return base64url(encoder.encode(s));
}

function base64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<string> {
  const sig = await hmacSha256Hex(secret, data);
  // hex → bytes → base64url
  const bytes = new Uint8Array(sig.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
  return base64url(bytes);
}

export async function signJwt(payload: JwtPayload, secret: string, kid: "current" | "previous" = "current"): Promise<string> {
  const header = { alg: "HS256", typ: "JWT", kid };
  const headerEnc = base64urlString(JSON.stringify(header));
  const payloadEnc = base64urlString(JSON.stringify(payload));
  const signing = `${headerEnc}.${payloadEnc}`;
  const sig = await hmac(secret, signing);
  return `${signing}.${sig}`;
}

export interface VerifyResult {
  ok: true;
  payload: JwtPayload;
}
export interface VerifyError {
  ok: false;
  reason: "malformed" | "bad_signature" | "expired" | "wrong_alg" | "wrong_aud" | "wrong_iss" | "wrong_tenant" | "future_iat";
}

/**
 * Verify-Pfad mit Doppel-Reader (#A-005):
 * `secret` kann ein einzelner String (Backward-Compat) oder ein {current,previous}-Set
 * sein. Bei Header-`kid="previous"` wird previous bevorzugt; sonst current zuerst,
 * previous als Fallback während Karenz.
 */
export async function verifyJwt(
  token: string,
  secret: string | JwtSecretSet,
  expectedTenantId?: string,
  expectedAud: string = "grosshandel.api",
): Promise<VerifyResult | VerifyError> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: "current" | "previous" };
  try { header = JSON.parse(new TextDecoder().decode(base64urlDecode(h))); } catch { return { ok: false, reason: "malformed" }; }
  if (header.alg !== "HS256") return { ok: false, reason: "wrong_alg" };

  const secretSet: JwtSecretSet = typeof secret === "string" ? { current: secret } : secret;
  // kid="previous" → versuche previous zuerst, sonst current zuerst.
  const ordered: string[] = [];
  if (header.kid === "previous" && secretSet.previous) {
    ordered.push(secretSet.previous, secretSet.current);
  } else {
    ordered.push(secretSet.current);
    if (secretSet.previous) ordered.push(secretSet.previous);
  }
  let sigOk = false;
  for (const sec of ordered) {
    const expected = await hmac(sec, `${h}.${p}`);
    if (constantTimeEqual(expected, s)) { sigOk = true; break; }
  }
  if (!sigOk) return { ok: false, reason: "bad_signature" };

  let payload: JwtPayload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlDecode(p))) as JwtPayload; } catch { return { ok: false, reason: "malformed" }; }

  if (payload.aud !== expectedAud) return { ok: false, reason: "wrong_aud" };
  if (expectedTenantId && payload.tenant_id !== expectedTenantId) return { ok: false, reason: "wrong_tenant" };
  // Issuer-Pin (#A-003): erwarteter Issuer = `tenants:<id>`. Schützt gegen Cross-Issuer-Reuse.
  if (expectedTenantId && payload.iss !== `tenants:${expectedTenantId}`) return { ok: false, reason: "wrong_iss" };
  const now = Math.floor(Date.now() / 1000);
  // Clock-Skew-Toleranz ±60s (#A-004)
  const SKEW = 60;
  if (payload.exp < now - SKEW) return { ok: false, reason: "expired" };
  // iat-Future-Reject (#A-004): Token darf nicht aus der Zukunft kommen
  if (typeof payload.iat === "number" && payload.iat > now + SKEW) return { ok: false, reason: "future_iat" };

  return { ok: true, payload };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
