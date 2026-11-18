import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { products, type Product, type NewProduct } from "../db/schema/products";
import { CodedError } from "../errors/catalog";

export async function findById(db: DB, tenant_id: string, id: string): Promise<Product | null> {
  const rows = await db.select().from(products).where(and(eq(products.id, id), eq(products.tenant_id, tenant_id), isNull(products.deleted_at))).limit(1);
  return rows[0] ?? null;
}

export async function requireById(db: DB, tenant_id: string, id: string): Promise<Product> {
  const row = await findById(db, tenant_id, id);
  if (!row) throw new CodedError("GH-PROD-001");
  return row;
}

export async function findBySkuCode(db: DB, tenant_id: string, sku_code: string): Promise<Product | null> {
  const rows = await db.select().from(products).where(and(eq(products.tenant_id, tenant_id), eq(products.sku_code, sku_code), isNull(products.deleted_at))).limit(1);
  return rows[0] ?? null;
}

export async function create(db: DB, p: NewProduct): Promise<Product> {
  const inserted = await db.insert(products).values(p).returning();
  const row = inserted[0];
  if (!row) throw new Error("product insert returned no row");
  return row;
}

export async function update(db: DB, tenant_id: string, id: string, patch: Partial<NewProduct>): Promise<Product> {
  const now = new Date().toISOString();
  const updated = await db.update(products).set({ ...patch, updated_at: now }).where(and(eq(products.id, id), eq(products.tenant_id, tenant_id), isNull(products.deleted_at))).returning();
  const row = updated[0];
  if (!row) throw new CodedError("GH-PROD-001");
  return row;
}

export async function softDelete(db: DB, tenant_id: string, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.update(products).set({ deleted_at: now, updated_at: now }).where(and(eq(products.id, id), eq(products.tenant_id, tenant_id), isNull(products.deleted_at)));
}

/**
 * Token-basierte Volltext-Suche.
 *
 * #Q-001: User-Input wird LIKE-escaped (% _ \ → \% \_ \\). ESCAPE '\\'-Klausel
 * via Raw-SQL, weil Drizzle's `like()`-Helper kein ESCAPE unterstützt.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function search(db: DB, tenant_id: string, q: string, limit = 20): Promise<Product[]> {
  const tokens = q.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0).slice(0, 5);
  if (tokens.length === 0) return [];
  const conds = tokens.map((tok) => {
    const p = `%${escapeLikePattern(tok)}%`;
    return or(
      sql`${products.name} LIKE ${p} ESCAPE '\\'`,
      sql`${products.sku_code} LIKE ${p} ESCAPE '\\'`,
      sql`${products.description} LIKE ${p} ESCAPE '\\'`,
      sql`${products.attributes} LIKE ${p} ESCAPE '\\'`,
    );
  });
  return db.select().from(products).where(and(eq(products.tenant_id, tenant_id), isNull(products.deleted_at), ...conds)).limit(limit);
}

export async function list(db: DB, tenant_id: string, opts: { cursor?: { created_at: string; id: string }; limit?: number } = {}): Promise<Product[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.cursor
    ? and(eq(products.tenant_id, tenant_id), isNull(products.deleted_at), lt(products.created_at, opts.cursor.created_at))
    : and(eq(products.tenant_id, tenant_id), isNull(products.deleted_at));
  return db.select().from(products).where(where).orderBy(desc(products.created_at)).limit(limit);
}
