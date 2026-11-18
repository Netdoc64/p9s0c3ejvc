import { describe, expect, it } from "vitest";
import { resolvePricing, roundHalfToEven } from "../../src/engines/pricing";
import type { CustomerSpecialPrice, PriceList, PriceListItem, QtyBreak } from "../../src/db/schema/pricing";

const list: PriceList = {
  id: "pl_1",
  tenant_id: "t_1",
  name: "Default",
  currency: "EUR",
  is_default: 1,
  valid_from: "2024-01-01T00:00:00Z",
  valid_to: null,
  created_at: "2024-01-01T00:00:00Z",
  archived_at: null,
};
const item: PriceListItem = { id: "pli_1", price_list_id: "pl_1", sku_id: "sku_rose", unit_price_cents: 100, created_at: "2024-01-01T00:00:00Z" };

describe("pricing engine", () => {
  it("list-only: kein qty_break, kein special → list-Preis", () => {
    const r = resolvePricing(
      { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 5, on_date: "2026-04-29T00:00:00Z" },
      { customer_special: [], applicable_price_list: list, list_item: item, qty_breaks: [] },
    );
    expect(r.unit_price_cents).toBe(100);
    expect(r.decision_reason).toBe("list_item");
  });

  it("qty_break absolute: qty>=min_qty greift", () => {
    const breaks: QtyBreak[] = [
      { id: "b1", price_list_id: "pl_1", sku_id: "sku_rose", min_qty: 10, unit_price_cents: 80, pct_off: null, created_at: "2024-01-01T00:00:00Z" },
      { id: "b2", price_list_id: "pl_1", sku_id: "sku_rose", min_qty: 50, unit_price_cents: 60, pct_off: null, created_at: "2024-01-01T00:00:00Z" },
    ];
    const r = resolvePricing(
      { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 50, on_date: "2026-04-29T00:00:00Z" },
      { customer_special: [], applicable_price_list: list, list_item: item, qty_breaks: breaks },
    );
    expect(r.unit_price_cents).toBe(60); // höchster qualifizierter
    expect(r.decision_reason).toContain("qty_break_absolute");
  });

  it("qty_break percent: 25% off von 100 = 75", () => {
    const breaks: QtyBreak[] = [
      { id: "b1", price_list_id: "pl_1", sku_id: "sku_rose", min_qty: 10, unit_price_cents: null, pct_off: 25, created_at: "2024-01-01T00:00:00Z" },
    ];
    const r = resolvePricing(
      { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 12, on_date: "2026-04-29T00:00:00Z" },
      { customer_special: [], applicable_price_list: list, list_item: item, qty_breaks: breaks },
    );
    expect(r.unit_price_cents).toBe(75);
  });

  it("customer_special schlägt qty_break", () => {
    const breaks: QtyBreak[] = [
      { id: "b1", price_list_id: "pl_1", sku_id: "sku_rose", min_qty: 10, unit_price_cents: 50, pct_off: null, created_at: "2024-01-01T00:00:00Z" },
    ];
    const csp: CustomerSpecialPrice[] = [
      { id: "csp1", tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", unit_price_cents: 30, valid_from: "2024-01-01T00:00:00Z", valid_to: null, created_at: "2024-01-01T00:00:00Z" },
    ];
    const r = resolvePricing(
      { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 100, on_date: "2026-04-29T00:00:00Z" },
      { customer_special: csp, applicable_price_list: list, list_item: item, qty_breaks: breaks },
    );
    expect(r.unit_price_cents).toBe(30);
    expect(r.decision_reason).toBe("customer_special_price");
  });

  it("kein list_item → GH-PRICE-001", () => {
    expect(() => resolvePricing(
      { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 1, on_date: "2026-04-29T00:00:00Z" },
      { customer_special: [], applicable_price_list: list, list_item: null, qty_breaks: [] },
    )).toThrowError(/GH-PRICE-001|No applicable/);
  });

  it("Determinismus: gleiche Inputs → gleiche Outputs (Snapshot)", () => {
    const breaks: QtyBreak[] = [
      { id: "b1", price_list_id: "pl_1", sku_id: "sku_rose", min_qty: 10, unit_price_cents: 80, pct_off: null, created_at: "2024-01-01T00:00:00Z" },
    ];
    const args = { tenant_id: "t_1", customer_id: "cust_x", sku_id: "sku_rose", qty: 12, on_date: "2026-04-29T00:00:00Z" };
    const ctx = { customer_special: [], applicable_price_list: list, list_item: item, qty_breaks: breaks };
    const a = resolvePricing(args, ctx);
    const b = resolvePricing(args, ctx);
    expect(a).toEqual(b);
  });

  it("roundHalfToEven: banker's rounding", () => {
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(3.5)).toBe(4);
    expect(roundHalfToEven(2.49)).toBe(2);
    expect(roundHalfToEven(2.51)).toBe(3);
  });
});
