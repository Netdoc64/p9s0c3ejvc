import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { api_keys, tenants } from "../db/schema/tenants";
import { randomSecret, sha256Hex } from "../lib/crypto";
import { CodedError } from "../errors/catalog";
import type { Env } from "../env";
import { invalidateTenant } from "../lib/tenant-cache";

const GRACE_DAYS = 7;

export interface RotateApiKeyResult {
  api_key_id: string;
  new_api_key_plain: string;
  new_hmac_secret: string;
  previous_until: string;
}

/**
 * Rotiert API-Key + HMAC-Secret. Alte Werte bleiben 7 Tage gültig (Doppel-Reader).
 * Auth-Middleware muss `*_previous` während dieser Karenz akzeptieren.
 */
export async function rotateApiKey(db: DB, api_key_id: string): Promise<RotateApiKeyResult> {
  const rows = await db.select().from(api_keys).where(eq(api_keys.id, api_key_id)).limit(1);
  const k = rows[0];
  if (!k) throw new CodedError("GH-AUTH-001");
  if (k.revoked_at) throw new CodedError("GH-SECRET-001", { reason: "key_already_revoked" });
  if (k.hmac_secret_previous_until && new Date(k.hmac_secret_previous_until).getTime() > Date.now()) {
    throw new CodedError("GH-SECRET-001", { reason: "rotation_in_progress" });
  }

  const new_plain = `gh_${randomSecret(24)}`;
  const new_hmac = randomSecret(32);
  const new_hash = await sha256Hex(new_plain);
  const previous_until = new Date(Date.now() + GRACE_DAYS * 86_400_000).toISOString();

  await db.update(api_keys).set({
    key_hash: new_hash,
    key_hash_previous: k.key_hash,
    key_hash_previous_until: previous_until,
    hmac_secret: new_hmac,
    hmac_secret_previous: k.hmac_secret,
    hmac_secret_previous_until: previous_until,
  }).where(eq(api_keys.id, api_key_id));

  return { api_key_id, new_api_key_plain: new_plain, new_hmac_secret: new_hmac, previous_until };
}

export async function rotateTenantJwtSecret(db: DB, tenant_id: string, env?: Env): Promise<{ tenant_id: string; previous_until: string }> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, tenant_id)).limit(1);
  const t = rows[0];
  if (!t) throw new CodedError("GH-TENANT-001");
  if (t.customer_jwt_secret_previous_until && new Date(t.customer_jwt_secret_previous_until).getTime() > Date.now()) {
    throw new CodedError("GH-SECRET-001", { reason: "rotation_in_progress" });
  }
  const new_secret = randomSecret(32);
  const previous_until = new Date(Date.now() + GRACE_DAYS * 86_400_000).toISOString();
  await db.update(tenants).set({
    customer_jwt_secret: new_secret,
    customer_jwt_secret_previous: t.customer_jwt_secret,
    customer_jwt_secret_previous_until: previous_until,
  }).where(eq(tenants.id, tenant_id));
  // Cache-Invalidate (#A-013): KV-Cache muss nach Rotation neu lesen.
  if (env) await invalidateTenant(env, tenant_id, t.slug);
  return { tenant_id, previous_until };
}

/** Cleanup-Job (M17): nullt `*_previous` wenn Karenz abgelaufen. */
export async function cleanupExpiredPreviousSecrets(db: DB): Promise<{ api_keys_cleaned: number; tenants_cleaned: number }> {
  const now = new Date().toISOString();
  const akAll = await db.select().from(api_keys);
  let akCleaned = 0;
  for (const r of akAll) {
    if (r.hmac_secret_previous_until && r.hmac_secret_previous_until < now) {
      await db.update(api_keys).set({ hmac_secret_previous: null, hmac_secret_previous_until: null, key_hash_previous: null, key_hash_previous_until: null }).where(eq(api_keys.id, r.id));
      akCleaned += 1;
    }
  }
  const tAll = await db.select().from(tenants);
  let tCleaned = 0;
  for (const r of tAll) {
    if (r.customer_jwt_secret_previous_until && r.customer_jwt_secret_previous_until < now) {
      await db.update(tenants).set({ customer_jwt_secret_previous: null, customer_jwt_secret_previous_until: null }).where(eq(tenants.id, r.id));
      tCleaned += 1;
    }
  }
  return { api_keys_cleaned: akCleaned, tenants_cleaned: tCleaned };
}
