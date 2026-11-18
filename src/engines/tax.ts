import { CodedError } from "../errors/catalog";
import type { TaxRule } from "../db/schema/tax";

export type TaxScheme =
  | "standard"
  | "reduced"
  | "zero"
  | "reverse_charge_eu"
  | "export"
  | "oss_b2c"
  | "kleinunternehmer";

export interface TaxInput {
  tenant_country: string;
  customer_country: string;
  b2b_b2c: "b2b" | "b2c";
  vat_status: "valid" | "invalid" | "unknown" | "not_required";
  sku_tax_class: "standard" | "reduced" | "zero";
  on_date: string;
}

export interface TaxResult {
  scheme: TaxScheme;
  rate_pct: number;
  rule_id: string;
  decision_reason: string;
  warning?: "vies_unknown";
}

/**
 * Pure Funktion. Eingabe-Regelliste muss bereits auf `valid_from <= on_date < valid_to`
 * vorgefiltert sein (siehe `tax-resolver.ts`).
 */
export function resolveTax(input: TaxInput, rules: TaxRule[]): TaxResult {
  // VIES "unknown" wird wie "not_required" / B2C behandelt (Plan-Decision)
  const treatAsB2c = input.vat_status === "unknown" && input.b2b_b2c === "b2b";
  const effective: TaxInput = treatAsB2c
    ? { ...input, b2b_b2c: "b2c", vat_status: "not_required" }
    : input;

  const isCrossBorder = effective.tenant_country !== effective.customer_country;
  const matches = rules.filter((r) => {
    if (r.match_tenant_country && r.match_tenant_country !== effective.tenant_country) return false;
    if (r.match_customer_country && r.match_customer_country !== effective.customer_country) return false;
    if (r.match_b2b_b2c && r.match_b2b_b2c !== effective.b2b_b2c) return false;
    if (r.match_vat_status && r.match_vat_status !== effective.vat_status) return false;
    if (r.match_sku_tax_class && r.match_sku_tax_class !== effective.sku_tax_class) return false;
    if (r.match_cross_border !== null && r.match_cross_border !== undefined) {
      if ((r.match_cross_border === 1) !== isCrossBorder) return false;
    }
    return true;
  });

  if (matches.length === 0) {
    throw new CodedError("GH-TAX-001", { reason: "no_match", input: effective });
  }

  // Sort: priority asc (niedriger gewinnt), dann specificity desc als Tiebreak.
  const scored = matches.map((r) => ({
    rule: r,
    specificity:
      (r.match_tenant_country ? 1 : 0) +
      (r.match_customer_country ? 1 : 0) +
      (r.match_b2b_b2c ? 1 : 0) +
      (r.match_vat_status ? 1 : 0) +
      (r.match_sku_tax_class ? 1 : 0) +
      (r.match_cross_border !== null && r.match_cross_border !== undefined ? 1 : 0),
    priority: r.priority ?? 100,
  }));
  scored.sort((a, b) => a.priority - b.priority || b.specificity - a.specificity);
  const top = scored[0];
  if (!top) throw new CodedError("GH-TAX-001");

  const tied = scored.filter((s) => s.priority === top.priority && s.specificity === top.specificity);
  if (tied.length > 1) {
    throw new CodedError("GH-TAX-001", { reason: "ambiguous", rule_ids: tied.map((t) => t.rule.rule_id) });
  }

  const result: TaxResult = {
    scheme: top.rule.scheme as TaxScheme,
    rate_pct: top.rule.rate_pct,
    rule_id: top.rule.rule_id,
    decision_reason: top.rule.decision_reason_template,
    ...(treatAsB2c ? { warning: "vies_unknown" as const } : {}),
  };
  return result;
}
