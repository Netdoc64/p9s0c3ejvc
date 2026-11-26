import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choose, sellPrice, DEFAULT_RULES } from "../../src/sourcing/engine";
import { toCents } from "../../src/sourcing/offers";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const BASE = "https://example.com";
let t: SeededTenant;

beforeEach(async () => { t = await seedTenant({ slug: "src-a" }); });
afterEach(async () => {
  await env.DB.prepare("DELETE FROM price_list_items").run();
  await env.DB.prepare("DELETE FROM price_lists").run();
  await env.DB.prepare("DELETE FROM products").run();
  await env.DB.prepare("DELETE FROM supplier_records").run();
  await clearTenants();
});

async function api(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = await signedHeaders({ apiKey: t.api_key_plain, hmacSecret: t.hmac_secret, method, pathname: path, body: raw });
  return SELF.fetch(`${BASE}${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const item = (sku: string, price: string, qty = 100) => ({ sku, name: `Rose ${sku}`, unit: "stem", unit_price: price, currency: "EUR", available_quantity: qty, minimum_quantity: 10 });

async function upload(source: string, items: unknown[], revision = 1, expires = future()) {
  const res = await api("POST", `/v1/suppliers/imports/${source}`, { revision, expires_at: expires, items });
  expect(res.status).toBeLessThan(300);
}

async function priceOf(skuId: string): Promise<{ unit_price_cents: number; managed_by: string | null } | null> {
  return env.DB.prepare("SELECT unit_price_cents, managed_by FROM price_list_items WHERE sku_id = ?").bind(skuId).first();
}

describe("Quellenmix — Rechenregeln", () => {
  it("Cent aufrunden, Aufschlag, Mindestmarge, Raster", () => {
    expect(toCents("0.275")).toBe(28);
    expect(toCents("1")).toBe(100);
    expect(toCents("0.001")).toBe(1);
    expect(sellPrice(28, { ...DEFAULT_RULES, markup_pct: 50, round_to_cents: 5 })).toBe(45);
    expect(sellPrice(100, { ...DEFAULT_RULES, markup_pct: 10, min_margin_cents: 50 })).toBe(150);
  });

  it("Strategien: günstigste, Reihenfolge, schnellste; ohne Menge keine Quelle", () => {
    const base = { connection: "x", sku: "s", name: "n", unit: "u", currency: "EUR", minimum_quantity: 1, expires_at: null, pack: 1 };
    const a = { ...base, provider: "file-import", source_ref: "a", cost_cents: 30, available_quantity: 5, delivery_from: "2027-01-03" };
    const b = { ...base, provider: "floriday", source_ref: "b", cost_cents: 40, available_quantity: 5, delivery_from: "2027-01-01" };
    expect(choose([a, b], DEFAULT_RULES)?.source_ref).toBe("a");
    expect(choose([a, b], { ...DEFAULT_RULES, strategy: "priority", priority: ["floriday"] })?.source_ref).toBe("b");
    expect(choose([a, b], { ...DEFAULT_RULES, strategy: "fastest" })?.source_ref).toBe("b");
    expect(choose([{ ...a, available_quantity: 0 }], DEFAULT_RULES)).toBeNull();
    expect(choose([{ ...a, pack: 10 }], DEFAULT_RULES)).toBeNull();
  });
});

describe("Quellenmix — End to End", () => {
  it("Datei-Angebote erscheinen gemischt, lassen sich übernehmen und bekommen einen Preis", async () => {
    await upload("lieferant-a", [item("R1", "0.275"), item("R2", "0.50")]);
    const offers = (await (await api("GET", "/v1/sourcing/offers")).json()) as { items: Array<{ source_ref: string; cost_cents: number }>; total: number };
    expect(offers.total).toBe(2);
    expect(offers.items.find((o) => o.source_ref === "R1")?.cost_cents).toBe(28);

    expect((await api("PUT", "/v1/sourcing/rules", { strategy: "cheapest", markup_pct: 50, round_to_cents: 5 })).status).toBe(200);
    const imp = await api("POST", "/v1/sourcing/import", { items: [{ provider: "file-import", connection: "lieferant-a", source_ref: "R1" }] });
    expect(imp.status).toBe(201);
    const body = (await imp.json()) as { created: string[]; recompute: { priced: number } };
    expect(body.created).toHaveLength(1);
    expect(body.recompute.priced).toBe(1);
    expect(await priceOf(body.created[0] as string)).toEqual({ unit_price_cents: 45, managed_by: "sourcing" });

    const state = (await (await api("GET", "/v1/sourcing/state")).json()) as { items: Array<Record<string, unknown>> };
    expect(state.items[0]).toMatchObject({ provider: "file-import", source_ref: "R1", cost_cents: 28, price_cents: 45, available_units: 100 });
  });

  it("zwei Quellen für einen Artikel: die günstigere gewinnt, fällt sie weg, übernimmt die andere", async () => {
    await upload("lieferant-a", [item("R1", "0.40")]);
    await upload("lieferant-b", [item("X9", "0.30")]);
    const imp = (await (await api("POST", "/v1/sourcing/import", { items: [{ provider: "file-import", connection: "lieferant-a", source_ref: "R1" }] })).json()) as { created: string[] };
    const sku = imp.created[0] as string;
    await api("PUT", `/v1/sourcing/products/${sku}/sources`, [
      { provider: "file-import", connection: "lieferant-a", source_ref: "R1" },
      { provider: "file-import", connection: "lieferant-b", source_ref: "X9" },
    ]);
    expect(((await (await api("GET", `/v1/sourcing/products/${sku}/sources`)).json()) as { state: { source_ref: string } }).state.source_ref).toBe("X9");
    await upload("lieferant-b", [], 2);
    await api("POST", "/v1/sourcing/recompute");
    expect(((await (await api("GET", `/v1/sourcing/products/${sku}/sources`)).json()) as { state: { source_ref: string } }).state.source_ref).toBe("R1");
  });

  it("ein von Hand gepflegter Preis wird nie überschrieben", async () => {
    await upload("lieferant-a", [item("R1", "0.275")]);
    const imp = (await (await api("POST", "/v1/sourcing/import", { items: [{ provider: "file-import", connection: "lieferant-a", source_ref: "R1" }] })).json()) as { created: string[] };
    const sku = imp.created[0] as string;
    await env.DB.prepare("UPDATE price_list_items SET unit_price_cents = 999, managed_by = NULL WHERE sku_id = ?").bind(sku).run();
    const res = (await (await api("PUT", "/v1/sourcing/rules", { strategy: "cheapest", markup_pct: 200 })).json()) as { recompute: { kept_manual: number } };
    expect(res.recompute.kept_manual).toBe(1);
    expect(await priceOf(sku)).toEqual({ unit_price_cents: 999, managed_by: null });
  });

  it("abgelaufene Stände und ausgeschaltete Module liefern keine Angebote", async () => {
    await upload("lieferant-a", [item("R1", "0.275")]);
    const imp = (await (await api("POST", "/v1/sourcing/import", { items: [{ provider: "file-import", connection: "lieferant-a", source_ref: "R1" }] })).json()) as { created: string[] };
    await api("PUT", "/v1/modules/file-import", { enabled: false });
    expect(((await (await api("GET", "/v1/sourcing/offers")).json()) as { total: number }).total).toBe(0);
    await api("POST", "/v1/sourcing/recompute");
    const st = (await (await api("GET", `/v1/sourcing/products/${imp.created[0]}/sources`)).json()) as { state: { reason: string; available_units: number } };
    expect(st.state).toMatchObject({ reason: "keine_gueltige_quelle", available_units: 0 });
  });

  it("fremde Währung und unbekannte Angebote werden nicht übernommen", async () => {
    await upload("lieferant-a", [{ ...item("U1", "1.00"), currency: "USD" }]);
    expect(((await (await api("GET", "/v1/sourcing/offers")).json()) as { total: number }).total).toBe(0);
    const imp = (await (await api("POST", "/v1/sourcing/import", { items: [{ provider: "file-import", connection: "lieferant-a", source_ref: "U1" }] })).json()) as { missing: string[]; created: string[] };
    expect(imp.created).toHaveLength(0);
    expect(imp.missing).toHaveLength(1);
  });
});
