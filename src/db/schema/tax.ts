import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tax_rules = sqliteTable(
  "tax_rules",
  {
    id: text("id").primaryKey(),
    tenant_id: text("tenant_id"),
    rule_id: text("rule_id").notNull(),
    description: text("description").notNull(),
    match_tenant_country: text("match_tenant_country"),
    match_customer_country: text("match_customer_country"),
    match_b2b_b2c: text("match_b2b_b2c"),
    match_vat_status: text("match_vat_status"),
    match_sku_tax_class: text("match_sku_tax_class"),
    match_cross_border: integer("match_cross_border"),
    scheme: text("scheme").notNull(),
    rate_pct: real("rate_pct").notNull(),
    decision_reason_template: text("decision_reason_template").notNull(),
    priority: integer("priority").notNull().default(100),
    valid_from: text("valid_from").notNull(),
    valid_to: text("valid_to"),
    created_at: text("created_at").notNull(),
  },
  (t) => ({ by_lookup: index("idx_tax_rules_lookup").on(t.tenant_id, t.valid_from, t.valid_to) }),
);

export type TaxRule = typeof tax_rules.$inferSelect;
