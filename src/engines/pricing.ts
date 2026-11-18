import { CodedError } from "../errors/catalog";
import type { CustomerSpecialPrice, PriceList, PriceListItem, QtyBreak } from "../db/schema/pricing";

export interface PricingInput {
  tenant_id: string;
  customer_id: string;
  sku_id: string;
  qty: number;
  on_date: string;
}

export interface PricingContext {
  customer_special: CustomerSpecialPrice[];
  applicable_price_list: PriceList;
  list_item: PriceListItem | null;
  qty_breaks: QtyBreak[];
}

export interface PriceBreakdownStep {
  rule: "customer_special" | "qty_break_absolute" | "qty_break_pct" | "list_item";
  applied: boolean;
  value_cents: number;
  detail?: string;
}

export interface PricingResult {
  unit_price_cents: number;
  breakdown: PriceBreakdownStep[];
  list_id: string | null;
  decision_reason: string;
  currency: string;
}

/**
 * Pure function — alle Daten injiziert.
 * Reihenfolge (v1): customer_special > qty_break > list_item.
 * Plan-Revision-Kandidat: customer_group_special, time-bound promos.
 */
export function resolvePricing(input: PricingInput, ctx: PricingContext): PricingResult {
  const breakdown: PriceBreakdownStep[] = [];

  // 1. customer_special (höchste Priorität)
  const cspMatch = ctx.customer_special.find((c) =>
    c.sku_id === input.sku_id &&
    c.valid_from <= input.on_date &&
    (!c.valid_to || c.valid_to > input.on_date),
  );
  if (cspMatch) {
    breakdown.push({ rule: "customer_special", applied: true, value_cents: cspMatch.unit_price_cents });
    return {
      unit_price_cents: cspMatch.unit_price_cents,
      breakdown,
      list_id: ctx.applicable_price_list.id,
      decision_reason: "customer_special_price",
      currency: ctx.applicable_price_list.currency,
    };
  }

  // 2. list-item als Basis
  if (!ctx.list_item) {
    throw new CodedError("GH-PRICE-001", { reason: "no_list_item", sku_id: input.sku_id });
  }
  const baseUnitPrice = ctx.list_item.unit_price_cents;
  breakdown.push({ rule: "list_item", applied: true, value_cents: baseUnitPrice });

  // 3. qty_break: nimm den höchsten min_qty <= input.qty.
  const eligible = ctx.qty_breaks
    .filter((b) => (b.sku_id === input.sku_id || b.sku_id === null) && b.min_qty <= input.qty)
    .sort((a, b) => b.min_qty - a.min_qty);
  const top = eligible[0];

  let final = baseUnitPrice;
  let reason = "list_item";

  if (top) {
    if (top.unit_price_cents !== null && top.unit_price_cents !== undefined) {
      final = top.unit_price_cents;
      breakdown.push({ rule: "qty_break_absolute", applied: true, value_cents: final, detail: `min_qty=${top.min_qty}` });
      reason = `qty_break_absolute@min_qty=${top.min_qty}`;
    } else if (top.pct_off !== null && top.pct_off !== undefined) {
      // Integer-skalierte Berechnung (#M-001): pct_off auf Skala 10000 (4-Dezimal-Stellen),
      // dann Banker-Rounding auf Cent. Vermeidet Float-Drift wie 0.1+0.2 = 0.30000000000000004.
      const pctScaled = Math.round(top.pct_off * 100); // pct_off=12.5 → 1250 (= 12.50%)
      const numerator = baseUnitPrice * (10000 - pctScaled);
      final = roundHalfToEvenInt(numerator, 10000);
      breakdown.push({ rule: "qty_break_pct", applied: true, value_cents: final, detail: `min_qty=${top.min_qty}, pct=${top.pct_off}` });
      reason = `qty_break_pct@min_qty=${top.min_qty}`;
    }
  }

  return {
    unit_price_cents: final,
    breakdown,
    list_id: ctx.applicable_price_list.id,
    decision_reason: reason,
    currency: ctx.applicable_price_list.currency,
  };
}

/** Banker's Rounding (half-to-even) für Float — Legacy/Test-Surface. */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Banker's Rounding über Integer-Division: returnt round(numerator/divisor) half-to-even.
 * Bevorzugt für Geldarithmetik (#M-001): kein Float-Drift.
 */
export function roundHalfToEvenInt(numerator: number, divisor: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quot = Math.floor(abs / divisor);
  const rem = abs - quot * divisor;
  const twice = rem * 2;
  let rounded: number;
  if (twice < divisor) rounded = quot;
  else if (twice > divisor) rounded = quot + 1;
  else rounded = quot % 2 === 0 ? quot : quot + 1; // exact half → even
  return sign * rounded;
}
