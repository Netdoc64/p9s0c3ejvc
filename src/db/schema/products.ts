import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    sku_code: text("sku_code").notNull(),
    parent_sku_id: text("parent_sku_id"),
    name: text("name").notNull(),
    description: text("description"),
    tax_class: text("tax_class").notNull().default("standard"),
    is_perishable: integer("is_perishable").notNull().default(0),
    default_shelf_life_days: integer("default_shelf_life_days"),
    min_order_qty: integer("min_order_qty").notNull().default(1),
    packaging_units: text("packaging_units").notNull().default("[]"),
    attributes: text("attributes").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    deleted_at: text("deleted_at"),
  },
  (t) => ({
    uniq_sku: uniqueIndex("uniq_products_tenant_sku").on(t.tenant_id, t.sku_code).where(sql`${t.deleted_at} IS NULL`),
    by_tenant: index("idx_products_tenant").on(t.tenant_id).where(sql`${t.deleted_at} IS NULL`),
    by_parent: index("idx_products_parent").on(t.parent_sku_id).where(sql`${t.parent_sku_id} IS NOT NULL`),
  }),
);

export const product_images = sqliteTable(
  "product_images",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    sku_id: text("sku_id").notNull(),
    r2_key: text("r2_key").notNull(),
    hash: text("hash").notNull(),
    content_type: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ by_sku: index("idx_product_images_sku").on(t.sku_id) }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductImage = typeof product_images.$inferSelect;
