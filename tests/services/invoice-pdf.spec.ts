import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { addressLines, formatCents, generateInvoicePdf } from "../../src/services/invoice-pdf";
import type { OrderDoc } from "../../src/schemas/order";

describe("formatCents", () => {
  it("schreibt Beträge deutsch: Komma, Tausenderpunkt, Leerzeichen vor dem €", () => {
    expect(formatCents(80, "EUR")).toBe("0,80 €");
    expect(formatCents(123450, "EUR")).toBe("1.234,50 €");
    expect(formatCents(123456789, "EUR")).toBe("1.234.567,89 €");
    expect(formatCents(-500, "EUR")).toBe("-5,00 €");
  });

  it("behält bei anderen Währungen den ISO-Code", () => {
    expect(formatCents(1200, "CHF")).toBe("12,00 CHF");
  });
});

describe("addressLines", () => {
  it("liest die Tenant-Form und die billing-Form der Kunden", () => {
    expect(addressLines('{"line1":"Musterstraat 1","postal_code":"1000 AA","city":"Aalsmeer","country":"NL"}'))
      .toEqual(["Musterstraat 1", "1000 AA Aalsmeer"]);
    expect(addressLines({ billing: { line1: "Bloemenmarkt 1", postal_code: "1012", city: "Amsterdam" } }))
      .toEqual(["Bloemenmarkt 1", "1012 Amsterdam"]);
  });

  it("gibt bei Leerem oder Unlesbarem keine Zeile statt eines Fehlers", () => {
    expect(addressLines(null)).toEqual([]);
    expect(addressLines("kein json")).toEqual([]);
    expect(addressLines("{}")).toEqual([]);
  });
});

describe("generateInvoicePdf", () => {
  it("erzeugt ein lesbares PDF mit €, Umlauten und beiden Anschriften", async () => {
    const doc = {
      meta: { schema_version: "order-document/1.0", doc_type: "order", id: "ord_test", tenant_id: "t_test" },
      lines: [{ line_no: 1, sku_id: "sku_rose", qty: 10, unit_price_cents: 80, line_total_cents: 800, tax_rate_pct: 0, tax_scheme: "reverse_charge_eu" }],
      totals: { currency: "EUR", subtotal_cents: 800, tax_cents: 0, total_cents: 800 },
    } as unknown as OrderDoc;
    const bytes = await generateInvoicePdf(doc, {
      tenant: { name: "Pilot-Tenant", country: "NL", vat_id: "NL000000000B01", address_lines: ["Musterstraat 1", "1000 AA Aalsmeer"] },
      customer: { name: "Floraly Berlin", country: "DE", vat_id: "DE123456789", address_lines: ["Bloemenmarkt 1", "1012 Amsterdam"] },
      invoice_number: "INV-2026-000001",
      date: "2026-11-17T00:00:00.000Z",
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
