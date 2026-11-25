/**
 * Mitarbeiter-Anmeldung für das Händler-Dashboard.
 *
 * Ein Mitarbeiter meldet sich per Mail-Code an (wie ein Kunde) und bekommt ein
 * Zugriffstoken für den Tenant-Bereich `/v1/*`. Drei Grenzen, alle hier:
 *
 * 1. EIGENE AUDIENCE. `aud = "grosshandel.staff"`; Kunden-Tokens tragen
 *    `grosshandel.api`. `verifyJwt` prüft die Audience — ein Kunden-Token kommt
 *    in den Tenant-Bereich nie hinein, ein Mitarbeiter-Token nie in /v1/customer.
 * 2. EIGENER SCHLÜSSEL. Signiert wird mit einem aus dem Tenant-Geheimnis
 *    ABGELEITETEN Schlüssel (sha256 über "staff:" + Geheimnis). Selbst eine
 *    vergessene Audience-Prüfung ließe kein Kunden-Token durch.
 * 3. JEDER AUFRUF PRÜFT DIE ZEILE. Ein gesperrter Mitarbeiter ist sofort draußen,
 *    nicht erst nach Ablauf des Tokens.
 *
 * Kein Refresh-Token: eine Sitzung gilt STAFF_TTL_SEC, danach neuer Code.
 */
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";
import { getTenantById } from "../lib/tenant-cache";
import { generate6DigitCode } from "./magic-link";
import { signJwt, verifyJwt, type JwtSecretSet } from "./jwt";

export const STAFF_AUD = "grosshandel.staff";
export const STAFF_TTL_SEC = 8 * 60 * 60;
const CODE_TTL_SEC = 600;
const MAX_ATTEMPTS = 5;

export type StaffRole = "owner" | "staff";
export interface StaffSession { tenant_id: string; staff_id: string; role: StaffRole }

async function staffKey(secret: string): Promise<string> {
  return sha256Hex(`staff:${secret}`);
}

async function staffSecretSet(t: { customer_jwt_secret: string; customer_jwt_secret_previous?: string | null; customer_jwt_secret_previous_until?: string | null }): Promise<JwtSecretSet> {
  const set: JwtSecretSet = { current: await staffKey(t.customer_jwt_secret) };
  if (t.customer_jwt_secret_previous && t.customer_jwt_secret_previous_until && t.customer_jwt_secret_previous_until > new Date().toISOString()) {
    set.previous = await staffKey(t.customer_jwt_secret_previous);
  }
  return set;
}

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** Code anfordern. Unbekannte Adresse: gleiche Antwort, kein Schreibzugriff (keine Enumeration). */
export async function requestStaffCode(env: Env, tenant_id: string, emailRaw: string): Promise<{ staff_id: string | null; code?: string; ttl_sec: number }> {
  const email = normalizeEmail(emailRaw);
  const row = await env.DB.prepare("SELECT id FROM staff_users WHERE tenant_id = ? AND email = ? AND disabled_at IS NULL")
    .bind(tenant_id, email).first<{ id: string }>();
  const code = generate6DigitCode();
  if (!row) {
    await sha256Hex(`${tenant_id}:dummy:${code}`);
    return { staff_id: null, ttl_sec: CODE_TTL_SEC };
  }
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare("UPDATE staff_login_codes SET consumed_at = ? WHERE staff_id = ? AND consumed_at IS NULL").bind(now.toISOString(), row.id),
    env.DB.prepare("INSERT INTO staff_login_codes (id, tenant_id, staff_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("event"), tenant_id, row.id, await sha256Hex(`${tenant_id}:${row.id}:${code}`), new Date(now.getTime() + CODE_TTL_SEC * 1000).toISOString(), now.toISOString()),
  ]);
  return { staff_id: row.id, code, ttl_sec: CODE_TTL_SEC };
}

/** Code einlösen → Zugriffstoken. Jeder Fehlversuch zählt, ab MAX_ATTEMPTS ist der Code tot. */
export async function verifyStaffCode(env: Env, tenant_id: string, emailRaw: string, code: string): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; tenant_id: string; role: StaffRole; roles: string[] }> {
  const email = normalizeEmail(emailRaw);
  const staff = await env.DB.prepare("SELECT id, role FROM staff_users WHERE tenant_id = ? AND email = ? AND disabled_at IS NULL")
    .bind(tenant_id, email).first<{ id: string; role: StaffRole }>();
  if (!staff) throw new CodedError("GH-AUTH-006");
  const nowIso = new Date().toISOString();
  const active = await env.DB.prepare(
    "SELECT id, code_hash, attempts FROM staff_login_codes WHERE staff_id = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(staff.id, nowIso).first<{ id: string; code_hash: string; attempts: number }>();
  if (!active || active.attempts >= MAX_ATTEMPTS) throw new CodedError("GH-AUTH-006");
  const hash = await sha256Hex(`${tenant_id}:${staff.id}:${code}`);
  if (hash !== active.code_hash) {
    await env.DB.prepare("UPDATE staff_login_codes SET attempts = attempts + 1 WHERE id = ?").bind(active.id).run();
    throw new CodedError("GH-AUTH-006");
  }
  // Nur einlösen, wenn noch offen — zwei gleichzeitige Einlösungen ergeben ein Token.
  const res = await env.DB.prepare("UPDATE staff_login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(nowIso, active.id).run();
  if (!res.meta.changes) throw new CodedError("GH-AUTH-006");

  const tenant = await getTenantById(env, tenant_id);
  if (!tenant) throw new CodedError("GH-TENANT-001");
  const now = Math.floor(Date.now() / 1000);
  const access_token = await signJwt({
    iss: `tenants:${tenant_id}`,
    sub: staff.id,
    aud: STAFF_AUD,
    exp: now + STAFF_TTL_SEC,
    iat: now,
    scope: ["staff", `staff.${staff.role}`],
    tenant_id,
    jti: newId("event"),
  }, await staffKey(tenant.customer_jwt_secret));
  return { access_token, token_type: "Bearer", expires_in: STAFF_TTL_SEC, tenant_id, role: staff.role, roles: [staff.role] };
}

/** Bearer-Token prüfen und die Zeile gegenlesen (gesperrt = draußen). */
export async function verifyStaffToken(env: Env, token: string): Promise<StaffSession> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new CodedError("GH-AUTH-002");
  let claimedTenant: string;
  try {
    const p = parts[1] as string;
    const json = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4))) as { tenant_id?: string };
    if (!json.tenant_id) throw new Error("tenant_id fehlt");
    claimedTenant = json.tenant_id;
  } catch {
    throw new CodedError("GH-AUTH-002");
  }
  const tenant = await getTenantById(env, claimedTenant);
  if (!tenant || tenant.status !== "active") throw new CodedError("GH-AUTH-001");
  const result = await verifyJwt(token, await staffSecretSet(tenant), tenant.id, STAFF_AUD);
  if (!result.ok) throw new CodedError(result.reason === "expired" ? "GH-AUTH-005" : "GH-AUTH-002");
  const row = await env.DB.prepare("SELECT role FROM staff_users WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL")
    .bind(result.payload.sub, tenant.id).first<{ role: StaffRole }>();
  if (!row) throw new CodedError("GH-AUTH-005");
  return { tenant_id: tenant.id, staff_id: result.payload.sub, role: row.role };
}

export async function addStaff(env: Env, tenant_id: string, emailRaw: string, role: StaffRole): Promise<{ id: string; email: string; role: StaffRole }> {
  const email = normalizeEmail(emailRaw);
  const id = newId("staff");
  try {
    await env.DB.prepare("INSERT INTO staff_users (id, tenant_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, tenant_id, email, role, new Date().toISOString()).run();
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("UNIQUE")) throw new CodedError("GH-STAFF-001");
    throw err;
  }
  return { id, email, role };
}
