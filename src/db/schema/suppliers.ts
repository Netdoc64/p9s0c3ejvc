import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants";

export const supplier_sync_state = sqliteTable("supplier_sync_state", {
  tenant_id: text("tenant_id").notNull().references(() => tenants.id),
  provider: text("provider").notNull(),
  connection: text("connection").notNull(),
  stream: text("stream").notNull(),
  sequence: integer("sequence").notNull().default(0),
  synced_at: text("synced_at"),
}, (t) => [primaryKey({ columns: [t.tenant_id, t.provider, t.connection, t.stream] })]);

export const supplier_records = sqliteTable("supplier_records", {
  tenant_id: text("tenant_id").notNull().references(() => tenants.id),
  provider: text("provider").notNull(),
  connection: text("connection").notNull(),
  stream: text("stream").notNull(),
  external_id: text("external_id").notNull(),
  sequence: integer("sequence").notNull(),
  deleted: integer("deleted").notNull().default(0),
  data: text("data").notNull(),
}, (t) => [primaryKey({ columns: [t.tenant_id, t.provider, t.connection, t.stream, t.external_id] })]);

export const supplier_purchase_orders = sqliteTable("supplier_purchase_orders", {
  tenant_id: text("tenant_id").notNull().references(() => tenants.id),
  id: text("id").notNull(),
  provider: text("provider").notNull(),
  connection: text("connection").notNull(),
  offer_id: text("offer_id").notNull(),
  request: text("request").notNull(),
  status: text("status", { enum: ["draft", "submitting", "unknown", "submitted", "rejected"] }).notNull(),
  provider_status: text("provider_status"),
  provider_sequence: integer("provider_sequence"),
  last_checked_at: text("last_checked_at"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenant_id, t.id] }),
  check("supplier_purchase_status", sql`${t.status} IN ('draft', 'submitting', 'unknown', 'submitted', 'rejected')`),
  index("supplier_purchase_pending").on(t.tenant_id, t.provider, t.connection, t.last_checked_at, t.created_at)
    .where(sql`${t.status} IN ('submitting', 'unknown', 'submitted')
      AND (${t.provider_status} IS NULL OR ${t.provider_status} IN ('PENDING', 'ACCEPTED'))`),
]);


export const supplier_dispatches = sqliteTable("supplier_dispatches", {
  tenant_id: text("tenant_id").notNull().references(() => tenants.id),
  provider: text("provider").notNull(),
  account: text("account").notNull(),
  id: text("id").notNull(),
  payload_hash: text("payload_hash").notNull(),
  status: text("status", { enum: ["sending", "unknown", "submitted", "rejected"] }).notNull(),
  remote_id: text("remote_id"),
}, (t) => [
  primaryKey({ columns: [t.tenant_id, t.provider, t.account, t.id] }),
  check("supplier_dispatch_status", sql`${t.status} IN ('sending', 'unknown', 'submitted', 'rejected')`),
]);
