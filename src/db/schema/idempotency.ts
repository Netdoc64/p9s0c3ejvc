import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const idempotency_locks = sqliteTable(
  "idempotency_locks",
  {
    tenant_id: text("tenant_id").notNull(),
    key: text("key").notNull(),
    payload_hash: text("payload_hash").notNull(),
    status: text("status").notNull().default("in_flight"),
    request_id: text("request_id").notNull(),
    created_at: text("created_at").notNull(),
    completed_at: text("completed_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.key] }),
    by_created: index("idx_idempotency_created").on(t.created_at),
  }),
);

export type IdempotencyLock = typeof idempotency_locks.$inferSelect;
