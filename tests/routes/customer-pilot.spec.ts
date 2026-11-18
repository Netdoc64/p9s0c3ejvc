import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signJwt } from "../../src/auth/jwt";
import { getDb } from "../../src/db/client";
import { customers } from "../../src/db/schema/customers";
import { orders } from "../../src/db/schema/orders";
import { newId } from "../../src/lib/ids";
import { readOperation, runOperation } from "../../src/services/customer-order-operations";
import type { Env } from "../../src/env";

// Wiederaufnahme von Bestellvorgängen der Pilot-App (operation_id) und CORS
// der Kunden-API. Ergänzt tests/routes/customer-api.spec.ts.

const CLIENT = { "X-Client-Version": "1.0.0", "X-Client-Platform": "ios" };

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

async function addOrder(customer_id: string, state: string): Promise<string> {
  const id = newId("order");
  const now = new Date().toISOString();
  await getDb(env.DB).insert(orders).values({ id, tenant_id: t.tenant_id, customer_id, state_current: state, total_cents: 0, currency: "EUR", etag: "x", created_at: now, updated_at: now });
  return id;
}

const E = env as unknown as Env;
/** Idempotenz-Schlüssel für Tests — berechnet, damit der Secret-Scan ihn nicht für einen API-Key hält. */
const idem = (name: string) => `idem_${name}_test`;
const owner = () => ({ tenant_id: t.tenant_id, customer_id: custA });

beforeEach(async () => {
  t = await seedTenant({ slug: `cust-pilot-${Math.random().toString(36).slice(2, 8)}` });
  custA = await addCustomer("Anna");
  custB = await addCustomer("Bert");
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM customer_order_operations").run();
  await env.DB.prepare("DELETE FROM orders").run();
  await env.DB.prepare("DELETE FROM customers").run();
  await clearTenants();
});

describe("runOperation", () => {
  it("führt einen Vorgang genau einmal aus und liefert bei Wiederholung dieselbe Antwort", async () => {
    let calls = 0;
    const op = { kind: "draft" as const, order_id: newId("order") };
    const first = await runOperation(E, owner(), "op_einmal_1", "key_einmal_1", op, { a: 1 }, async () => ({ n: ++calls }));
    const again = await runOperation(E, owner(), "op_einmal_1", "key_einmal_1", op, { a: 1 }, async () => ({ n: ++calls }));
    expect(first).toEqual({ n: 1 });
    expect(again).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("weist dieselbe operation_id mit anderem Inhalt ab (GH-IDEMP-001)", async () => {
    const op = { kind: "draft" as const, order_id: newId("order") };
    await runOperation(E, owner(), "op_inhalt_1", "key_inhalt_1", op, { a: 1 }, async () => ({ ok: true }));
    await expect(runOperation(E, owner(), "op_inhalt_1", "key_inhalt_1", op, { a: 2 }, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "GH-IDEMP-001" });
  });

  it("ein fehlgeschlagener Entwurf sperrt den Kunden nicht für den nächsten", async () => {
    const boom = new Error("Bestand reicht nicht");
    await expect(runOperation(E, owner(), "op_fehler_1", "key_fehler_1", { kind: "draft", order_id: newId("order") }, {}, async () => { throw boom; }))
      .rejects.toBe(boom);
    expect(await readOperation(E, owner(), "op_fehler_1")).toBeNull();
    const next = await runOperation(E, owner(), "op_fehler_2", "key_fehler_2", { kind: "draft", order_id: newId("order") }, {}, async () => ({ ok: true }));
    expect(next).toEqual({ ok: true });
  });

  it("eine fehlgeschlagene Bestätigung sperrt die Bestellung nicht", async () => {
    const order_id = await addOrder(custA, "awaiting_confirmation");
    await expect(runOperation(E, owner(), "op_conf_1", "key_conf_1", { kind: "confirm", order_id }, {}, async () => { throw new Error("x"); }))
      .rejects.toThrow("x");
    const retry = await runOperation(E, owner(), "op_conf_2", "key_conf_2", { kind: "confirm", order_id }, {}, async () => ({ ok: true }));
    expect(retry).toEqual({ ok: true });
  });

  it("ein trotz Fehler angelegter Entwurf behält seinen Claim (kein zweiter Auftrag)", async () => {
    const order_id = await addOrder(custA, "awaiting_confirmation");
    await expect(runOperation(E, owner(), "op_halb_1", "key_halb_1", { kind: "draft", order_id }, {}, async () => { throw new Error("Antwort verloren"); }))
      .rejects.toThrow();
    expect(await readOperation(E, owner(), "op_halb_1")).toMatchObject({ order_id, response_json: null });
  });
});

describe("Kunden-API mit operation_id", () => {
  it("ein neuer Warenkorb liefert nicht den offenen Entwurf zurück", async () => {
    const offen = await addOrder(custA, "awaiting_confirmation");
    const res = await SELF.fetch("https://example.com/v1/customer/orders", {
      method: "POST",
      headers: { ...CLIENT, "Content-Type": "application/json", "X-Idempotency-Key": idem("neu"), Authorization: `Bearer ${await token(custA)}` },
      body: JSON.stringify({ operation_id: "op_neu_12345", lines: [{ sku_id: "sku_unbekannt", qty: 1 }] }),
    });
    const body = await res.json() as { id?: string };
    expect(body.id).not.toBe(offen);
  });

  it("Storno einer fremden Bestellung ist „nicht gefunden“ und legt keinen Vorgang an", async () => {
    const fremd = await addOrder(custB, "awaiting_confirmation");
    const res = await SELF.fetch(`https://example.com/v1/customer/orders/${fremd}/cancel`, {
      method: "POST",
      headers: { ...CLIENT, "Content-Type": "application/json", "X-Idempotency-Key": idem("fremd"), Authorization: `Bearer ${await token(custA)}` },
      body: JSON.stringify({ operation_id: "op_fremd_1234" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe("GH-ORDER-001");
    expect(await readOperation(E, owner(), "op_fremd_1234")).toBeNull();
  });

  it("ein unbekannter Vorgang darf wiederholt werden", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/order-operations/op_unbekannt_1", {
      headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "not_recorded", repeat_allowed: true });
  });

  it("antwortet mit Cache-Control: private, no-store", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/me", { headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` } });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("GET /order-operations/:id liest nur (#6)", () => {
  async function settledOrderWithOpenClaim(operation_id: string) {
    const order_id = newId("order");
    const now = new Date().toISOString();
    await getDb(env.DB).insert(orders).values({
      id: order_id, tenant_id: t.tenant_id, customer_id: custA, state_current: "confirmed", total_cents: 0, currency: "EUR",
      plan: JSON.stringify({ next_steps: [], executed_steps: [] }), issues: JSON.stringify({ blocking: [], warnings: [] }),
      totals: JSON.stringify({ subtotal_cents: 0, tax_cents: 0, total_cents: 0, currency: "EUR" }), etag: "e1", created_at: now, updated_at: now,
    });
    await env.DB.prepare(`INSERT INTO customer_order_operations
      (tenant_id, customer_id, operation_id, idempotency_key, order_id, kind, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 'confirm', 'h', ?)`).bind(t.tenant_id, custA, operation_id, idem(operation_id), order_id, now).run();
    return order_id;
  }
  const responseJson = (operation_id: string) => env.DB.prepare(
    "SELECT response_json FROM customer_order_operations WHERE tenant_id = ? AND customer_id = ? AND operation_id = ?",
  ).bind(t.tenant_id, custA, operation_id).first<{ response_json: string | null }>();

  it("meldet einen abgeschlossenen Vorgang als completed, ohne zu schreiben", async () => {
    const order_id = await settledOrderWithOpenClaim("op_lesen_0001");
    const res = await SELF.fetch("https://example.com/v1/customer/order-operations/op_lesen_0001", {
      headers: { ...CLIENT, Authorization: `Bearer ${await token(custA)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "completed", repeat_allowed: false, order: { id: order_id } });
    expect((await responseJson("op_lesen_0001"))?.response_json).toBeNull();
  });

  it("der nächste Schreibweg des Kunden schließt den offenen Vorgang ab", async () => {
    const order_id = await settledOrderWithOpenClaim("op_lesen_0002");
    await SELF.fetch("https://example.com/v1/customer/orders", {
      method: "POST",
      headers: { ...CLIENT, "Content-Type": "application/json", "X-Idempotency-Key": idem("schreib"), Authorization: `Bearer ${await token(custA)}` },
      body: JSON.stringify({ operation_id: "op_schreib_0001", lines: [{ sku_id: "sku_unbekannt", qty: 1 }] }),
    });
    const saved = (await responseJson("op_lesen_0002"))?.response_json;
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved as string)).toMatchObject({ id: order_id });
  });

  it("ein fremder Vorgang bleibt für andere Kunden unsichtbar", async () => {
    await settledOrderWithOpenClaim("op_lesen_0003");
    const res = await SELF.fetch("https://example.com/v1/customer/order-operations/op_lesen_0003", {
      headers: { ...CLIENT, Authorization: `Bearer ${await token(custB)}` },
    });
    expect(await res.json()).toMatchObject({ state: "not_recorded" });
  });
});

describe("CORS der Kunden-API", () => {
  it("gibt fremden Origins ohne Freigabe kein CORS", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/me", {
      method: "OPTIONS",
      headers: { Origin: "https://fremd.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });

  it("gibt der konfigurierten App-Origin CORS (CUSTOMER_APP_ORIGINS, vitest.config.ts)", async () => {
    const res = await SELF.fetch("https://example.com/v1/customer/me", {
      method: "OPTIONS",
      headers: { Origin: "https://app.pilot.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.pilot.example");
  });
});
