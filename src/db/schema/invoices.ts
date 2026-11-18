import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    order_id: text("order_id").notNull(),
    invoice_number: text("invoice_number").notNull(),
    total_cents: integer("total_cents").notNull(),
    currency: text("currency").notNull(),
    country: text("country").notNull(),
    pdf_r2_key: text("pdf_r2_key"),
    pdf_hash: text("pdf_hash"),
    bytes: integer("bytes"),
    generated_at: text("generated_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => ({
    by_tenant: index("idx_invoices_tenant").on(t.tenant_id, t.created_at),
    by_order: index("idx_invoices_order").on(t.order_id),
    uniq_number: uniqueIndex("uniq_invoice_number").on(t.tenant_id, t.invoice_number),
  }),
);

export const invoice_number_seq = sqliteTable("invoice_number_seq", {
  tenant_id: text("tenant_id").primaryKey(),
  next_number: integer("next_number").notNull().default(1),
  prefix: text("prefix").notNull().default("INV"),
  updated_at: text("updated_at").notNull(),
});

export type Invoice = typeof invoices.$inferSelect;
