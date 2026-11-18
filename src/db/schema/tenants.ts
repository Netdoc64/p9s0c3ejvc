import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  currency: text("currency").notNull(),
  customer_jwt_secret: text("customer_jwt_secret").notNull(),
  customer_jwt_secret_previous: text("customer_jwt_secret_previous"),
  customer_jwt_secret_previous_until: text("customer_jwt_secret_previous_until"),
  status: text("status").notNull().default("active"),
  min_shelf_life_days: integer("min_shelf_life_days").notNull().default(3),
  // Pflichtangaben des Verkäufers auf Rechnungen (Migration 0021). JSON-Adresse.
  vat_id: text("vat_id"),
  address: text("address"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  deleted_at: text("deleted_at"),
});

export const api_keys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    key_hash: text("key_hash").notNull().unique(),
    hmac_secret: text("hmac_secret").notNull(),
    hmac_secret_previous: text("hmac_secret_previous"),
    hmac_secret_previous_until: text("hmac_secret_previous_until"),
    key_hash_previous: text("key_hash_previous"),
    key_hash_previous_until: text("key_hash_previous_until"),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("full"),
    created_at: text("created_at").notNull(),
    revoked_at: text("revoked_at"),
  },
  (t) => ({
    by_hash: index("idx_api_keys_hash").on(t.key_hash).where(sql`${t.revoked_at} IS NULL`),
    by_tenant: index("idx_api_keys_tenant").on(t.tenant_id),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type ApiKey = typeof api_keys.$inferSelect;
export type NewApiKey = typeof api_keys.$inferInsert;
