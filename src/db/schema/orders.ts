import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    customer_id: text("customer_id").notNull(),
    doc_type: text("doc_type").notNull().default("order"),
    schema_version: text("schema_version").notNull().default("order-document/1.0"),
    state_current: text("state_current").notNull(),
    total_cents: integer("total_cents").notNull().default(0),
    currency: text("currency").notNull(),
    customer_snapshot: text("customer_snapshot").notNull().default("{}"),
    source: text("source").notNull().default("{}"),
    actor: text("actor").notNull().default("{}"),
    totals: text("totals").notNull().default("{}"),
    plan: text("plan").notNull().default("{}"),
    audit: text("audit").notNull().default("{}"),
    gates_log: text("gates_log").notNull().default("{}"),
    external_refs: text("external_refs").notNull().default("{}"),
    issues: text("issues").notNull().default("{}"),
    state_history: text("state_history").notNull().default("[]"),
    parent_order_id: text("parent_order_id"),
    etag: text("etag").notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => ({
    by_tenant: index("idx_orders_tenant").on(t.tenant_id, t.created_at),
    by_customer: index("idx_orders_customer").on(t.tenant_id, t.customer_id),
    by_state: index("idx_orders_state").on(t.tenant_id, t.state_current),
  }),
);

export const order_lines = sqliteTable(
  "order_lines",
  {
    id: text("id").primaryKey(),
    order_id: text("order_id").notNull(),
    line_no: integer("line_no").notNull(),
    sku_id: text("sku_id").notNull(),
    warehouse_id: text("warehouse_id"),
    qty: integer("qty").notNull(),
    unit_price_cents: integer("unit_price_cents"),
    tax_scheme: text("tax_scheme"),
    tax_rate_pct: real("tax_rate_pct"),
    tax_rule_id: text("tax_rule_id"),
    line_total_cents: integer("line_total_cents"),
    reservation_id: text("reservation_id"),
    resolution: text("resolution").notNull().default("{}"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    uniq_no: uniqueIndex("uniq_order_lines_no").on(t.order_id, t.line_no),
    by_order: index("idx_order_lines_order").on(t.order_id),
  }),
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderLineRow = typeof order_lines.$inferSelect;
export type NewOrderLineRow = typeof order_lines.$inferInsert;
