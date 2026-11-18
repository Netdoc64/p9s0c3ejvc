import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signJwt } from "../../src/auth/jwt";
import { getDb } from "../../src/db/client";
import { customers } from "../../src/db/schema/customers";
import { orders } from "../../src/db/schema/orders";
import { newId } from "../../src/lib/ids";
import { allowedActions, toCustomerView } from "../../src/services/customer-orders";
import type { OrderDoc } from "../../src/schemas/order";

const CLIENT = { "X-Client-Version": "1.0.0", "X-Client-Platform": "ios" };

let t: SeededTenant;
let custA: string;
let custB: string;

async function token(customer_id: string, scope: string[] = ["customer_self.read", "customer_self.write"]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: `tenants:${t.tenant_id}`, sub: customer_id, aud: "grosshandel.api", exp: now + 600, iat: now, scope, tenant_id: t.tenant_id, jti: newId("event") } as never, t.customer_jwt_secret);
}

async function addCustomer(name: string): Promise<string> {
  const id = newId("customer");
  const now = new Date().toISOString();
  await getDb(env.DB).insert(customers).values({ id, tenant_id: t.tenant_id, name, email: `${name.toLowerCase()}@kunde.example`, country: "DE", b2b_b2c: "b2b", vat_status: "valid", addresses: "{}", metadata: "{}", created_at: now, updated_at: now });
  return id;
}

beforeEach(async () => {
  t = await seedTenant({ slug: `cust-api-${Math.random().toString(36).slice(2, 8)}` });
  custA = await addCustomer("Anna");
  custB = await addCustomer("Bert");
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM orders").run();
  await env.DB.prepare("DELETE FROM customers").run();
  await clearTenants();
});

describe("Kunden-API /v1/customer", () => {
  it("verlangt Client-Version und Plattform (M24)", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/me", { headers: { Authorization: `Bearer ${await token(custA)}` } });
    expect(res.status).toBe(400);
  });

  it("GET /me liefert den Kunden der Sitzung und den Händler", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/me", { headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { customer: { id: string; name: string }; merchant: { currency: string } };
    expect(body.customer.id).toBe(custA);
    expect(body.customer.name).toBe("Anna");
    expect(body.merchant.currency).toBe("EUR");
  });

  it("eine fremde Bestellung ist „nicht gefunden“, nicht „verboten“", async () => {
    const id = newId("order");
    const now = new Date().toISOString();
    await getDb(env.DB).insert(orders).values({ id, tenant_id: t.tenant_id, customer_id: custB, state_current: "draft", total_cents: 0, currency: "EUR", etag: "x", created_at: now, updated_at: now });
    const res = await SELF.fetch(`https://example.com/v1/customer/orders/${id}`, { headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` } });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("GH-ORDER-001");
  });

  it("die Auftragsliste zeigt nur eigene Bestellungen", async () => {
    const now = new Date().toISOString();
    const db = getDb(env.DB);
    await db.insert(orders).values({ id: newId("order"), tenant_id: t.tenant_id, customer_id: custA, state_current: "confirmed", total_cents: 800, currency: "EUR", etag: "a", created_at: now, updated_at: now });
    await db.insert(orders).values({ id: newId("order"), tenant_id: t.tenant_id, customer_id: custB, state_current: "confirmed", total_cents: 900, currency: "EUR", etag: "b", created_at: now, updated_at: now });
    const res = await SELF.fetch("https://example.com/v1/customer/orders", { headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` } });
    const body = await res.json() as { items: Array<{ total_cents: number }> };
    expect(body.items.map((i) => i.total_cents)).toEqual([800]);
  });

  it("ein Nur-Lese-Token darf nicht bestellen", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/orders", {
      method: "POST",
      headers: { ...CLIENT, "Content-Type": "application/json", Authorization: `Bearer ${await token(custA, ["customer_self.read"])}` },
      body: JSON.stringify({ lines: [{ sku_id: "sku_x", qty: 1 }] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("Kundenansicht", () => {
  const doc = {
    meta: { schema_version: "order-document/1.0", doc_type: "order", id: "ord_1", tenant_id: "t_1" },
    customer_id: "cust_1",
    lines: [{ line_no: 1, sku_id: "sku_a", qty: 2, unit_price_cents: 80, tax_rate_pct: 0, line_total_cents: 160, warehouse_id: "wh_main", reservation_id: "res_geheim", resolution: { fefo_allocations: [] } }],
    totals: { subtotal_cents: 160, tax_cents: 0, total_cents: 160, currency: "EUR" },
    state: { current: "awaiting_confirmation", history: [{ from: null, to: "draft", ts: "2026-11-17T10:00:00.000Z" }] },
    plan: { next_steps: [], executed_steps: [{ type: "reserve_stock", decision_reason: "intern" }] },
    external_refs: { invoice_pdf_r2_key: "t_1/invoices/x.pdf" },
    issues: { blocking: [], warnings: [{ code: "intern" }] },
    gates_log: { credit: "intern" },
    audit: { ai_decisions: ["intern"] },
  } as unknown as OrderDoc;

  it("gibt nur freigegebene Felder aus — kein plan, audit, gates_log, Lager, Reservierung, R2-Schlüssel", () => {
    const v = toCustomerView(doc, { sku_a: "Rose Naomi 40cm" });
    const json = JSON.stringify(v);
    for (const geheim of ["plan", "audit", "gates_log", "wh_main", "res_geheim", "invoice_pdf_r2_key", "fefo_allocations", "intern"]) {
      expect(json, geheim).not.toContain(geheim);
    }
    expect(v.lines[0]?.name).toBe("Rose Naomi 40cm");
    expect(v.allowed_actions).toEqual(["confirm", "cancel"]);
  });

  it("Kunden stornieren nur, was noch nicht verbindlich ist", () => {
    expect(allowedActions("awaiting_confirmation")).toEqual(["confirm", "cancel"]);
    expect(allowedActions("on_hold")).toEqual(["cancel"]);
    expect(allowedActions("confirmed")).toEqual([]);
    expect(allowedActions("cancelled")).toEqual([]);
  });
});
