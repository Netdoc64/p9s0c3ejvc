import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenant_pricing_feeds = sqliteTable(
  "tenant_pricing_feeds",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    adapter: text("adapter").notNull(),
    url: text("url").notNull(),
    schedule: text("schedule").notNull().default("0 5 * * *"),
    drift_threshold_pct: real("drift_threshold_pct").notNull().default(50.0),
    drift_skus_pct: real("drift_skus_pct").notNull().default(5.0),
    enabled: integer("enabled").notNull().default(1),
    last_run_at: text("last_run_at"),
    notes: text("notes"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => ({ by_tenant: index("idx_feeds_tenant").on(t.tenant_id).where(sql`${t.enabled} = 1`) }),
);

export const feed_runs = sqliteTable(
  "feed_runs",
  {
    id: text("id").primaryKey(),
    feed_id: text("feed_id").notNull(),
    tenant_id: text("tenant_id").notNull(),
    status: text("status").notNull(),
    rows_imported: integer("rows_imported"),
    rows_skipped: integer("rows_skipped"),
    drift_pct: real("drift_pct"),
    drift_blocked: integer("drift_blocked").notNull().default(0),
    new_price_list_id: text("new_price_list_id"),
    error_code: text("error_code"),
    error_detail: text("error_detail"),
    started_at: text("started_at").notNull(),
    ended_at: text("ended_at"),
  },
  (t) => ({ by_lookup: index("idx_feed_runs_lookup").on(t.feed_id, t.started_at) }),
);

export type TenantPricingFeed = typeof tenant_pricing_feeds.$inferSelect;
