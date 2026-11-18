import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { DB } from "../db/client";
import { customers, type Customer, type NewCustomer } from "../db/schema/customers";
import { CodedError } from "../errors/catalog";

export async function findById(db: DB, tenant_id: string, id: string): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.tenant_id, tenant_id), isNull(customers.deleted_at)))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireById(db: DB, tenant_id: string, id: string): Promise<Customer> {
  const row = await findById(db, tenant_id, id);
  // Cross-tenant access SAME treatment as missing → 404 (no leak).
  if (!row) throw new CodedError("GH-CUST-001");
  return row;
}

export async function findByVatId(db: DB, tenant_id: string, vat_id: string): Promise<Customer | null> {
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenant_id, tenant_id), eq(customers.vat_id, vat_id), isNull(customers.deleted_at)))
    .limit(1);
  return rows[0] ?? null;
}

export async function create(db: DB, c: NewCustomer): Promise<Customer> {
  const inserted = await db.insert(customers).values(c).returning();
  const row = inserted[0];
  if (!row) throw new Error("customer insert returned no row");
  return row;
}

export async function update(db: DB, tenant_id: string, id: string, patch: Partial<NewCustomer>): Promise<Customer> {
  const now = new Date().toISOString();
  const updated = await db
    .update(customers)
    .set({ ...patch, updated_at: now })
    .where(and(eq(customers.id, id), eq(customers.tenant_id, tenant_id), isNull(customers.deleted_at)))
    .returning();
  const row = updated[0];
  if (!row) throw new CodedError("GH-CUST-001");
  return row;
}

export interface ListParams {
  cursor?: { created_at: string; id: string };
  limit?: number;
}

export async function list(db: DB, tenant_id: string, params: ListParams = {}): Promise<Customer[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const where = params.cursor
    ? and(
        eq(customers.tenant_id, tenant_id),
        isNull(customers.deleted_at),
        lt(customers.created_at, params.cursor.created_at),
      )
    : and(eq(customers.tenant_id, tenant_id), isNull(customers.deleted_at));
  return db.select().from(customers).where(where).orderBy(desc(customers.created_at)).limit(limit);
}

export async function softDelete(db: DB, tenant_id: string, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(customers)
    .set({ deleted_at: now, updated_at: now })
    .where(and(eq(customers.id, id), eq(customers.tenant_id, tenant_id), isNull(customers.deleted_at)));
}
