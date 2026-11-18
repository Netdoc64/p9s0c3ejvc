import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const price_lists = sqliteTable(
  "price_lists",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    is_default: integer("is_default").notNull().default(0),
    valid_from: text("valid_from").notNull(),
    valid_to: text("valid_to"),
    created_at: text("created_at").notNull(),
    archived_at: text("archived_at"),
  },
  (t) => ({ by_tenant: index("idx_price_lists_tenant").on(t.tenant_id) }),
);

export const price_list_items = sqliteTable(
  "price_list_items",
  {
    id: text("id").primaryKey(),
    price_list_id: text("price_list_id").notNull(),
    sku_id: text("sku_id").notNull(),
    unit_price_cents: integer("unit_price_cents").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ uniq: uniqueIndex("uniq_pli_list_sku").on(t.price_list_id, t.sku_id) }),
);

export const qty_breaks = sqliteTable(
  "qty_breaks",
  {
    id: text("id").primaryKey(),
    price_list_id: text("price_list_id").notNull(),
    sku_id: text("sku_id"),
    min_qty: integer("min_qty").notNull(),
    unit_price_cents: integer("unit_price_cents"),
    pct_off: real("pct_off"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ by_lookup: index("idx_qty_breaks_lookup").on(t.price_list_id, t.sku_id, t.min_qty) }),
);

export const customer_special_prices = sqliteTable(
  "customer_special_prices",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    customer_id: text("customer_id").notNull(),
    sku_id: text("sku_id").notNull(),
    unit_price_cents: integer("unit_price_cents").notNull(),
    valid_from: text("valid_from").notNull(),
    valid_to: text("valid_to"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ by_lookup: index("idx_csp_lookup").on(t.customer_id, t.sku_id, t.valid_from) }),
);

// #Q-004: tenant_id ist Pflicht-Filter für Cross-Tenant-Defense-in-Depth.
// Composite PK (tenant_id, customer_id) erzwingt Single-Assignment pro Customer-Tenant.
export const customer_price_list_assignments = sqliteTable(
  "customer_price_list_assignments",
  {
    customer_id: text("customer_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    price_list_id: text("price_list_id").notNull(),
    assigned_at: text("assigned_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.customer_id] }),
    by_customer: index("idx_cpla_customer").on(t.tenant_id, t.customer_id),
  }),
);

export type PriceList = typeof price_lists.$inferSelect;
export type PriceListItem = typeof price_list_items.$inferSelect;
export type QtyBreak = typeof qty_breaks.$inferSelect;
export type CustomerSpecialPrice = typeof customer_special_prices.$inferSelect;
