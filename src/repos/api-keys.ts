import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { api_keys, type ApiKey, type NewApiKey } from "../db/schema/tenants";
import { sha256Hex } from "../lib/crypto";
import { CodedError } from "../errors/catalog";

export async function findByPlain(db: DB, plain: string): Promise<ApiKey | null> {
  const hash = await sha256Hex(plain);
  const rows = await db.select().from(api_keys).where(and(eq(api_keys.key_hash, hash), isNull(api_keys.revoked_at))).limit(1);
  return rows[0] ?? null;
}

export async function listForTenant(db: DB, tenant_id: string): Promise<ApiKey[]> {
  return db.select().from(api_keys).where(eq(api_keys.tenant_id, tenant_id));
}

export async function create(db: DB, k: NewApiKey): Promise<ApiKey> {
  const inserted = await db.insert(api_keys).values(k).returning();
  const row = inserted[0];
  if (!row) throw new Error("api_key insert returned no row");
  return row;
}

export async function revoke(db: DB, id: string, tenant_id: string, now: string): Promise<void> {
  const result = await db
    .update(api_keys)
    .set({ revoked_at: now })
    .where(and(eq(api_keys.id, id), eq(api_keys.tenant_id, tenant_id), isNull(api_keys.revoked_at)));
  // drizzle-orm/d1 result shape varies; defensively check via re-read
  const after = await db.select({ id: api_keys.id, revoked_at: api_keys.revoked_at }).from(api_keys).where(eq(api_keys.id, id)).limit(1);
  if (!after[0] || !after[0].revoked_at) throw new CodedError("GH-INFRA-002", { reason: "api_key_revoke_failed" });
  return void result;
}
