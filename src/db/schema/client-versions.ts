import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const client_min_versions = sqliteTable(
  "client_min_versions",
  {
    tenant_id: text("tenant_id").notNull(),
    platform: text("platform").notNull(),
    min_version: text("min_version").notNull(),
    hard_cutoff_at: text("hard_cutoff_at"),
    soft_sunset_at: text("soft_sunset_at"),
    notes: text("notes"),
    updated_at: text("updated_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenant_id, t.platform] }) }),
);

export type ClientMinVersion = typeof client_min_versions.$inferSelect;
