import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    external_id: text("external_id"),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    country: text("country").notNull(),
    b2b_b2c: text("b2b_b2c").notNull(),
    vat_id: text("vat_id"),
    vat_status: text("vat_status").notNull().default("not_required"),
    vies_checked_at: text("vies_checked_at"),
    language: text("language"),
    credit_limit_cents: integer("credit_limit_cents"),
    blocked: integer("blocked").notNull().default(0),
    addresses: text("addresses").notNull().default("{}"),
    metadata: text("metadata").notNull().default("{}"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    deleted_at: text("deleted_at"),
  },
  (t) => ({
    by_tenant: index("idx_customers_tenant").on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`),
    uniq_vat: uniqueIndex("uniq_customers_tenant_vat").on(t.tenant_id, t.vat_id).where(sql`${t.vat_id} IS NOT NULL AND ${t.deleted_at} IS NULL`),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
