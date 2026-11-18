import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const stock_batches = sqliteTable(
  "stock_batches",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    warehouse_id: text("warehouse_id").notNull(),
    sku_id: text("sku_id").notNull(),
    qty: integer("qty").notNull(),
    mhd: text("mhd"),
    received_at: text("received_at").notNull(),
    status: text("status").notNull().default("active"),
    notes: text("notes"),
    created_at: text("created_at").notNull(),
    expired_at: text("expired_at"),
  },
  (t) => ({
    by_lookup: index("idx_batches_lookup").on(t.tenant_id, t.warehouse_id, t.sku_id, t.mhd),
    by_active: index("idx_batches_active").on(t.tenant_id, t.sku_id).where(sql`${t.status} = 'active'`),
  }),
);

export type StockBatch = typeof stock_batches.$inferSelect;
