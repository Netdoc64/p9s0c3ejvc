/**
 * Tenant-API-Keys ausstellen, ohne dass ein Mensch oder ein Agent den Wert sieht.
 *
 * Gegenstück ist der Zieltyp „remote-mint“ des Business Managers: er stößt per
 * POST an, wir würfeln, und der Wert geht GENAU EINMAL in der Antwort hinaus.
 * Danach liegt er nur noch beim Aufrufer; hier bleiben Prüfsumme und
 * HMAC-Geheimnis, wie bei jedem anderen Key.
 *
 * Der Wert ist EIN String: `<api_key>.<hmac_secret>`. Der Aufrufer kann je
 * Vorgang nur einen Wert entgegennehmen, ein Tenant-Zugang braucht aber zwei
 * Teile. Beide sind base64url und enthalten keinen Punkt; getrennt wird am
 * ersten Punkt.
 *
 * Je Tenant gibt es höchstens EINEN Key dieser Herkunft (Name `business-manager`).
 * Eine neue Ausgabe dreht ihn: der bisherige Wert gilt noch 24 Stunden weiter
 * (dieselbe Karenz wie bei jeder Rotation, siehe middleware/auth.ts), damit
 * ein Verteilen, das zwischen Ausgabe und Ziel hängen bleibt, nicht sofort den
 * laufenden Betrieb abschneidet.
 */
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { randomSecret, sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";

export const BM_KEY_NAME = "business-manager";
export const KARENZ_MS = 24 * 60 * 60 * 1000;

export interface Issued {
  value: string;
  fingerprint: string;
  tenant_id: string;
  api_key_id: string;
  rotated: boolean;
}

/** Teilt einen ausgegebenen Wert wieder in seine beiden Teile. */
export function splitIssued(value: string): { api_key: string; hmac_secret: string } {
  const i = value.indexOf(".");
  if (i <= 0 || i === value.length - 1) throw new Error("kein ausgegebener Tenant-Zugang");
  return { api_key: value.slice(0, i), hmac_secret: value.slice(i + 1) };
}

export async function issueTenantKey(env: Env, slug: string, idempotencyKey: string, now = new Date()): Promise<Issued> {
  const tenant = await env.DB.prepare("SELECT id, status FROM tenants WHERE slug = ? AND deleted_at IS NULL")
    .bind(slug).first<{ id: string; status: string }>();
  if (!tenant || tenant.status !== "active") throw new CodedError("GH-TENANT-001");

  const seen = await env.DB.prepare("SELECT 1 AS x FROM api_key_issuances WHERE idempotency_key = ?").bind(idempotencyKey).first();
  if (seen) throw new CodedError("GH-ADMIN-003");

  const existing = await env.DB.prepare(
    "SELECT id, key_hash, hmac_secret FROM api_keys WHERE tenant_id = ? AND name = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).bind(tenant.id, BM_KEY_NAME).first<{ id: string; key_hash: string; hmac_secret: string }>();

  const api_key = `gh_${randomSecret(24)}`;
  const hmac_secret = randomSecret(32);
  const key_hash = await sha256Hex(api_key);
  const nowIso = now.toISOString();
  const until = new Date(now.getTime() + KARENZ_MS).toISOString();
  const api_key_id = existing?.id ?? newId("api_key");

  const keyStmt = existing
    ? env.DB.prepare(
      `UPDATE api_keys SET key_hash_previous = key_hash, key_hash_previous_until = ?,
         hmac_secret_previous = hmac_secret, hmac_secret_previous_until = ?,
         key_hash = ?, hmac_secret = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).bind(until, until, key_hash, hmac_secret, existing.id)
    : env.DB.prepare(
      "INSERT INTO api_keys (id, tenant_id, key_hash, hmac_secret, name, scope, created_at) VALUES (?, ?, ?, ?, ?, 'full', ?)",
    ).bind(api_key_id, tenant.id, key_hash, hmac_secret, BM_KEY_NAME, nowIso);

  // Ein Batch ist eine Transaktion: kollidiert der Idempotency-Key (zwei
  // gleichzeitige Aufrufe), fällt auch der Key-Schritt weg — kein zweiter
  // Wert entsteht, der nie jemanden erreicht.
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO api_key_issuances (idempotency_key, tenant_id, api_key_id, rotated, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(idempotencyKey, tenant.id, api_key_id, existing ? 1 : 0, nowIso),
      keyStmt,
    ]);
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes("UNIQUE")) throw new CodedError("GH-ADMIN-003");
    throw err;
  }

  const value = `${api_key}.${hmac_secret}`;
  return { value, fingerprint: (await sha256Hex(value)).slice(0, 12), tenant_id: tenant.id, api_key_id, rotated: Boolean(existing) };
}
