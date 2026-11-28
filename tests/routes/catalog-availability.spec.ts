import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueTokenPair } from "../../src/auth/token-issuance";
import { adjust } from "../../src/services/stock";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";

const BASE = "https://example.com";
const CLIENT = { "X-Client-Version": "1.0.0", "X-Client-Platform": "web" };
let t: SeededTenant;
let token: string;
const now = () => new Date().toISOString();

beforeEach(async () => {
  t = await seedTenant({ slug: "kat-a" });
  await env.DB.prepare("INSERT INTO customers (id, tenant_id, name, email, country, b2b_b2c, created_at, updated_at) VALUES ('cust_k', ?, 'K', 'k@x.example', 'DE', 'b2b', ?, ?)")
    .bind(t.tenant_id, now(), now()).run();
  token = (await issueTokenPair(env as never, t.tenant_id, "cust_k", ["customer_self"])).access_token;
  for (const id of ["sku_lager", "sku_lief", "sku_beide", "sku_nichts"]) {
    await env.DB.prepare(`INSERT INTO products (id, tenant_id, sku_code, name, tax_class, is_perishable, min_order_qty, packaging_units, attributes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reduced', 0, 1, '[]', '{}', 'active', ?, ?)`).bind(id, t.tenant_id, id.toUpperCase(), id, now(), now()).run();
  }
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM products").run();
  await env.DB.prepare("DELETE FROM customers").run();
  await env.DB.prepare("DELETE FROM stock_movements").run();
  await clearTenants();
});

async function supplier(sku: string, units: number, expires = new Date(Date.now() + 86_400_000).toISOString()) {
  await env.DB.prepare(`INSERT INTO product_sourcing_state (tenant_id, sku_id, provider, connection, source_ref, cost_cents, price_cents, available_units, expires_at, reason, computed_at)
    VALUES (?, ?, 'file-import', 'l', ?, 10, 20, ?, ?, 'cheapest', ?)`).bind(t.tenant_id, sku, sku, units, expires, now()).run();
}

describe("Kundenkatalog: available_quantity (#55)", () => {
  it("Lager, Lieferant, beides (Maximum, nicht Summe), nichts", async () => {
    await adjust(env as never, { tenant_id: t.tenant_id, warehouse_id: "wh_default", sku_id: "sku_lager", qty_delta: 7, reason: "t" });
    await adjust(env as never, { tenant_id: t.tenant_id, warehouse_id: "wh_default", sku_id: "sku_beide", qty_delta: 5, reason: "t" });
    await supplier("sku_lief", 40);
    await supplier("sku_beide", 50);
    const res = await SELF.fetch(`${BASE}/v1/customer/products?limit=50`, { headers: { ...CLIENT, Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<{ id: string; available_quantity: number | null }> };
    const q = Object.fromEntries(items.map((i) => [i.id, i.available_quantity]));
    expect(q).toEqual({ sku_lager: 7, sku_lief: 40, sku_beide: 50, sku_nichts: 0 });

    const one = await SELF.fetch(`${BASE}/v1/customer/products/sku_beide`, { headers: { ...CLIENT, Authorization: `Bearer ${token}` } });
    expect(await one.json()).toMatchObject({ id: "sku_beide", available_quantity: 50 });
  });

  it("abgelaufene Lieferanten-Quelle zählt nicht", async () => {
    await supplier("sku_lief", 40, "2000-01-01T00:00:00.000Z");
    const one = await SELF.fetch(`${BASE}/v1/customer/products/sku_lief`, { headers: { ...CLIENT, Authorization: `Bearer ${token}` } });
    expect(await one.json()).toMatchObject({ available_quantity: 0 });
  });
});
