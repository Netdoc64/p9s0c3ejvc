import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    customer_id: text("customer_id").notNull(),
    platform: text("platform").notNull(),
    push_token: text("push_token").notNull(),
    app_version: text("app_version"),
    language: text("language"),
    timezone: text("timezone"),
    active: integer("active").notNull().default(1),
    last_seen_at: text("last_seen_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    uniq_token: uniqueIndex("uniq_device_token").on(t.push_token).where(sql`${t.active} = 1`),
    by_customer: index("idx_devices_customer").on(t.customer_id, t.active),
  }),
);

export type Device = typeof devices.$inferSelect;
