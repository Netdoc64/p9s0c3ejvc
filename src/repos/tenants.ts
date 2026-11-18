import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { tenants, type NewTenant, type Tenant } from "../db/schema/tenants";
import { CodedError } from "../errors/catalog";

export async function findById(db: DB, id: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(and(eq(tenants.id, id), isNull(tenants.deleted_at))).limit(1);
  return rows[0] ?? null;
}

export async function findBySlug(db: DB, slug: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(and(eq(tenants.slug, slug), isNull(tenants.deleted_at))).limit(1);
  return rows[0] ?? null;
}

export async function requireById(db: DB, id: string): Promise<Tenant> {
  const t = await findById(db, id);
  if (!t) throw new CodedError("GH-TENANT-001");
  return t;
}

export async function listActive(db: DB): Promise<Tenant[]> {
  return db.select().from(tenants).where(isNull(tenants.deleted_at));
}

export async function create(db: DB, t: NewTenant): Promise<Tenant> {
  const inserted = await db.insert(tenants).values(t).returning();
  const row = inserted[0];
  if (!row) throw new Error("tenant insert returned no row");
  return row;
}

export async function softDelete(db: DB, id: string, now: string): Promise<void> {
  await db.update(tenants).set({ deleted_at: now, status: "deleted", updated_at: now }).where(eq(tenants.id, id));
}
