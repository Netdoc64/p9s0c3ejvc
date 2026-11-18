import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { resolveTaxFromDb } from "../../src/services/tax-resolver";
import { resolveTax } from "../../src/engines/tax";

const onDate = "2026-04-29T12:00:00Z";

describe("tax engine — Snapshot-Szenarien", () => {
  it("Tenant DE → Kunde DE B2B → standard 19%", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "DE", customer_country: "DE", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "standard", on_date: onDate,
    });
    expect(result.scheme).toBe("standard");
    expect(result.rate_pct).toBe(19);
    expect(result.rule_id).toBe("de_standard");
  });

  it("Tenant NL → Kunde DE B2B mit gültiger VAT → reverse_charge_eu 0%", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "NL", customer_country: "DE", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "standard", on_date: onDate,
    });
    expect(result.scheme).toBe("reverse_charge_eu");
    expect(result.rate_pct).toBe(0);
    expect(result.rule_id).toBe("eu_b2b_reverse_charge");
  });

  it("Tenant DE → Kunde CH B2B → export 0%", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "DE", customer_country: "CH", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "standard", on_date: onDate,
    });
    expect(result.scheme).toBe("export");
    expect(result.rate_pct).toBe(0);
    expect(result.rule_id).toBe("ch_export");
  });

  it("VIES-status='unknown' → wie B2C behandelt + warning", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "DE", customer_country: "DE", b2b_b2c: "b2b",
      vat_status: "unknown", sku_tax_class: "standard", on_date: onDate,
    });
    expect(result.scheme).toBe("standard");
    expect(result.warning).toBe("vies_unknown");
  });

  it("SKU tax_class=zero → zero 0%", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "DE", customer_country: "DE", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "zero", on_date: onDate,
    });
    expect(result.scheme).toBe("zero");
    expect(result.rate_pct).toBe(0);
  });

  it("NL Reduced → 9%", async () => {
    const db = getDb(env.DB);
    const result = await resolveTaxFromDb(db, "t_test", {
      tenant_country: "NL", customer_country: "NL", b2b_b2c: "b2c",
      vat_status: "not_required", sku_tax_class: "reduced", on_date: onDate,
    });
    expect(result.scheme).toBe("reduced");
    expect(result.rate_pct).toBe(9);
  });

  it("kein passendes Land → GH-TAX-001", async () => {
    const db = getDb(env.DB);
    await expect(resolveTaxFromDb(db, "t_test", {
      tenant_country: "FR", customer_country: "FR", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "standard", on_date: onDate,
    })).rejects.toMatchObject({ code: "GH-TAX-001" });
  });
});

describe("tax engine — pure function ambiguity", () => {
  it("zwei Regeln gleicher Spezifität → GH-TAX-001 ambiguous", () => {
    const ts = "2024-01-01T00:00:00Z";
    const r1 = { id: "x1", tenant_id: null, rule_id: "rA", description: "", match_tenant_country: "DE", match_customer_country: "DE", match_b2b_b2c: null, match_vat_status: null, match_sku_tax_class: null, match_cross_border: null, scheme: "standard", rate_pct: 19, decision_reason_template: "A", priority: 100, valid_from: ts, valid_to: null, created_at: ts };
    const r2 = { ...r1, id: "x2", rule_id: "rB", scheme: "reduced", rate_pct: 7, decision_reason_template: "B" };
    expect(() => resolveTax({
      tenant_country: "DE", customer_country: "DE", b2b_b2c: "b2b",
      vat_status: "valid", sku_tax_class: "standard", on_date: "2026-01-01T00:00:00Z",
    }, [r1, r2])).toThrow(/ambiguous|matches/);
  });
});
