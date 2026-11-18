import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const outbox_events = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    topic: text("topic").notNull(),
    aggregate_id: text("aggregate_id").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    created_at: text("created_at").notNull(),
    retry_at: text("retry_at"),
    delivered_at: text("delivered_at"),
  },
  (t) => ({
    by_status: index("idx_outbox_status").on(t.status, t.created_at),
    by_tenant_topic: index("idx_outbox_tenant_topic").on(t.tenant_id, t.topic),
  }),
);

export const webhook_subscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    url: text("url").notNull(),
    topic_filter: text("topic_filter").notNull().default("*"),
    signing_secret: text("signing_secret").notNull(),
    active: integer("active").notNull().default(1),
    description: text("description"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    deleted_at: text("deleted_at"),
  },
  (t) => ({ by_tenant: index("idx_webhook_tenant").on(t.tenant_id, t.active).where(sql`${t.deleted_at} IS NULL`) }),
);

export const webhook_deliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    event_id: text("event_id").notNull(),
    subscription_id: text("subscription_id").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull(),
    response_status: integer("response_status"),
    latency_ms: integer("latency_ms"),
    error_detail: text("error_detail"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    by_event: index("idx_deliveries_event").on(t.event_id),
    by_subscription: index("idx_deliveries_subscription").on(t.subscription_id, t.created_at),
  }),
);

export type OutboxEvent = typeof outbox_events.$inferSelect;
export type WebhookSubscription = typeof webhook_subscriptions.$inferSelect;
