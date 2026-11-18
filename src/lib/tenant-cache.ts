/**
 * KV-Cache für Tenant-Lookups (#A-013, #A-018).
 *
 * Hot-Path: jeder Customer-authentifizierte Request muss Tenant-JWT-Secret
 * laden, jeder Public-Auth-Request muss Tenant-Slug→ID auflösen. Direkter
 * D1-Read pro Request killt p99-SLO `auth.duration_ms < 200`.
 *
 * Strategy: 60s KV-TTL. Invalidation bei Rotation/Slug-Change ist explizit
 * via `invalidateTenant()`-Helper. KV ist eventual-consistent → Karenz von
 * bis zu 60s zwischen Rotation und Invalidation, abgedeckt durch JWT-Doppel-
 * Reader (#A-005).
 */
import { and, eq, isNull } from "drizzle-orm";
import { tenants, type Tenant } from "../db/schema/tenants";
import { getDb } from "../db/client";
import type { Env } from "../env";

const TTL_SEC = 60;

interface CachedTenant {
  id: string;
  slug: string;
  status: string;
  country: string;
  currency: string;
  customer_jwt_secret: string;
  customer_jwt_secret_previous: string | null;
  customer_jwt_secret_previous_until: string | null;
  min_shelf_life_days: number;
  cached_at: string;
}

function bySlugKey(slug: string): string {
  return `tenant:slug:${slug}`;
}

function byIdKey(id: string): string {
  return `tenant:id:${id}`;
}

function toCached(t: Tenant): CachedTenant {
  return {
    id: t.id,
    slug: t.slug,
    status: t.status,
    country: t.country,
    currency: t.currency,
    customer_jwt_secret: t.customer_jwt_secret,
    customer_jwt_secret_previous: t.customer_jwt_secret_previous,
    customer_jwt_secret_previous_until: t.customer_jwt_secret_previous_until,
    min_shelf_life_days: t.min_shelf_life_days,
    cached_at: new Date().toISOString(),
  };
}

export async function getTenantById(env: Env, tenant_id: string): Promise<CachedTenant | null> {
  try {
    const cached = await env.KV.get<CachedTenant>(byIdKey(tenant_id), "json");
    if (cached) return cached;
  } catch { /* fail-open zu D1 */ }

  const db = getDb(env.DB);
  const rows = await db.select().from(tenants).where(and(eq(tenants.id, tenant_id), isNull(tenants.deleted_at))).limit(1);
  const t = rows[0];
  if (!t) return null;
  const entry = toCached(t);
  try {
    await env.KV.put(byIdKey(tenant_id), JSON.stringify(entry), { expirationTtl: TTL_SEC });
    await env.KV.put(bySlugKey(t.slug), JSON.stringify(entry), { expirationTtl: TTL_SEC });
  } catch { /* best-effort */ }
  return entry;
}

export async function getTenantBySlug(env: Env, slug: string): Promise<CachedTenant | null> {
  try {
    const cached = await env.KV.get<CachedTenant>(bySlugKey(slug), "json");
    if (cached) return cached;
  } catch { /* fail-open */ }
  const db = getDb(env.DB);
  const rows = await db.select().from(tenants).where(and(eq(tenants.slug, slug), isNull(tenants.deleted_at))).limit(1);
  const t = rows[0];
  if (!t) return null;
  const entry = toCached(t);
  try {
    await env.KV.put(byIdKey(t.id), JSON.stringify(entry), { expirationTtl: TTL_SEC });
    await env.KV.put(bySlugKey(slug), JSON.stringify(entry), { expirationTtl: TTL_SEC });
  } catch { /* best-effort */ }
  return entry;
}

export async function invalidateTenant(env: Env, tenant_id: string, slug?: string): Promise<void> {
  try {
    await env.KV.delete(byIdKey(tenant_id));
    if (slug) await env.KV.delete(bySlugKey(slug));
  } catch { /* best-effort */ }
}
