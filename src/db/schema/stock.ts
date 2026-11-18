import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const warehouses = sqliteTable(
  "warehouses",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    country: text("country").notNull(),
    is_default: integer("is_default").notNull().default(0),
    created_at: text("created_at").notNull(),
    archived_at: text("archived_at"),
  },
  (t) => ({ by_tenant: index("idx_warehouses_tenant").on(t.tenant_id).where(sql`${t.archived_at} IS NULL`) }),
);

export const stock_movements = sqliteTable(
  "stock_movements",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    warehouse_id: text("warehouse_id").notNull(),
    sku_id: text("sku_id").notNull(),
    type: text("type").notNull(),
    qty_delta: integer("qty_delta").notNull(),
    reservation_id: text("reservation_id"),
    reason: text("reason"),
    actor_id: text("actor_id"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    by_lookup: index("idx_stock_movements_lookup").on(t.tenant_id, t.warehouse_id, t.sku_id, t.created_at),
    by_reservation: index("idx_stock_movements_reservation").on(t.reservation_id),
  }),
);

export type Warehouse = typeof warehouses.$inferSelect;
export type StockMovement = typeof stock_movements.$inferSelect;
