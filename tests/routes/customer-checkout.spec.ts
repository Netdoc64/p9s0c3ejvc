import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signJwt } from "../../src/auth/jwt";
import { getDb } from "../../src/db/client";
import { customers } from "../../src/db/schema/customers";
import { newId } from "../../src/lib/ids";
import * as ordersRepo from "../../src/repos/orders";
import * as stockSvc from "../../src/services/stock";
import type { Env } from "../../src/env";
import type { OrderDoc } from "../../src/schemas/order";

// Checkout-Servertests der Kunden-API (Pilotfall Q04): abgelaufene Reservierung,
// parallele Bestätigung, Storno nach Bestätigung, fremder Auftrag.

const CLIENT = { "X-Client-Version": "1.0.0", "X-Client-Platform": "ios" };
const E = env as unknown as Env;
const WH = "wh_checkout_test";
const SKU = "sku_checkout_test";

let t: SeededTenant;
let custA: string;
let custB: string;

async function token(customer_id: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: `tenants:${t.tenant_id}`, sub: customer_id, aud: "grosshandel.api", exp: now + 600, iat: now, scope: ["customer_self.read", "customer_self.write"], tenant_id: t.tenant_id, jti: newId("event") } as never, t.customer_jwt_secret);
}

async function addCustomer(name: string): Promise<string> {
  const id = newId("customer");
  const now = new Date().toISOString();
  await getDb(env.DB).insert(customers).values({ id, tenant_id: t.tenant_id, name, email: `${name.toLowerCase()}@kunde.example`, country: "DE", b2b_b2c: "b2b", vat_status: "valid", addresses: "{}", metadata: "{}", created_at: now, updated_at: now });
  return id;
}

/** Auftrag im Zustand awaiting_confirmation mit echter Reservierung im StockDO; `reservedAt` steuert das Ablaufdatum der Kundenansicht. */
async function awaitingOrder(customer_id: string, reservedAt = new Date()): Promise<{ id: string; etag: string }> {
  const scope = { tenant_id: t.tenant_id, warehouse_id: WH, sku_id: SKU };
  await stockSvc.adjust(E, { ...scope, qty_delta: 10, reason: "test" });
  const res = await stockSvc.reserve(E, { ...scope, qty: 2, customer_id });
  const id = newId("order");
  const ts = reservedAt.toISOString();
  const doc = {
    meta: { schema_version: "order-document/1.0", doc_type: "order", id, tenant_id: t.tenant_id, parent_order_id: null },
    customer_id,
    customer_snapshot: { id: customer_id, name: "Test", country: "DE", b2b_b2c: "b2b", vat_id: null, vat_status: "valid" },
    source: { channel: "mobile_app", actor: "customer" },
    actor: { type: "customer", id: customer_id },
    lines: [{ line_no: 1, sku_id: SKU, qty: 2, unit_price_cents: 100, tax_scheme: null, tax_rate_pct: 0, tax_rule_id: null, line_total_cents: 200, warehouse_id: WH, reservation_id: res.reservation_id, resolution: {} }],
    totals: { subtotal_cents: 200, tax_cents: 0, total_cents: 200, currency: "EUR" },
    state: { current: "awaiting_confirmation", history: [{ from: null, to: "draft", ts }, { from: "draft", to: "awaiting_confirmation", ts }] },
    plan: { next_steps: [], executed_steps: [{ step_id: "step_reserve", type: "reserve_stock", started_at: ts, ended_at: ts, decision_reason: "reserved" }] },
    external_refs: {},
    issues: { blocking: [], warnings: [] },
    gates_log: {},
    audit: {},
  } as unknown as OrderDoc;
  const created = await ordersRepo.create(getDb(env.DB), doc);
  return { id, etag: created.etag };
}

async function post(customer_id: string, path: string, body: unknown, idem?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/v1/customer${path}`, {
    method: "POST",
    headers: { ...CLIENT, "Content-Type": "application/json", Authorization: `Bearer ${await token(customer_id)}`, ...(idem ? { "X-Idempotency-Key": idem } : {}) },
    body: JSON.stringify(body),
  });
}

const code = async (r: Response) => (await r.json() as { code: string }).code;

beforeEach(async () => {
  t = await seedTenant({ slug: `cust-co-${Math.random().toString(36).slice(2, 8)}` });
  custA = await addCustomer("Anna");
  custB = await addCustomer("Bert");
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM customer_order_operations").run();
  await env.DB.prepare("DELETE FROM orders").run();
  await env.DB.prepare("DELETE FROM customers").run();
  await env.DB.prepare("DELETE FROM stock_movements").run();
  await clearTenants();
});

describe("Checkout der Kunden-API", () => {
  it("abgelaufene Reservierung → 410 GH-STOCK-002", async () => {
    const o = await awaitingOrder(custA, new Date(Date.now() - 3 * 3_600_000));
    const res = await post(custA, `/orders/${o.id}/confirm`, { operation_id: "op_abgelaufen_1", expected_revision: o.etag }, "idem_abgelaufen_1");
    expect(res.status).toBe(410);
    expect(await code(res)).toBe("GH-STOCK-002");
  });

  it("zwei parallele Bestätigungen → genau eine 200, die andere 409", async () => {
    const o = await awaitingOrder(custA);
    const [r1, r2] = await Promise.all([
      post(custA, `/orders/${o.id}/confirm`, { operation_id: "op_parallel_1", expected_revision: o.etag }, "idem_parallel_1"),
      post(custA, `/orders/${o.id}/confirm`, { operation_id: "op_parallel_2", expected_revision: o.etag }, "idem_parallel_2"),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(["GH-ORDER-002", "GH-STATE-001", "GH-IDEMP-001"]).toContain(await code(loser));
  });

  it("Storno nach Bestätigung → 409 GH-STATE-001", async () => {
    const o = await awaitingOrder(custA);
    const ok = await post(custA, `/orders/${o.id}/confirm`, {});
    expect(ok.status).toBe(200);
    const res = await post(custA, `/orders/${o.id}/cancel`, {});
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("GH-STATE-001");
  });

  it("Auftrag eines anderen Kunden → 404 GH-ORDER-001", async () => {
    const o = await awaitingOrder(custB);
    for (const path of ["confirm", "cancel"]) {
      const res = await post(custA, `/orders/${o.id}/${path}`, {});
      expect(res.status, path).toBe(404);
      expect(await code(res), path).toBe("GH-ORDER-001");
    }
  });
});
