import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signJwt } from "../../src/auth/jwt";
import { newId } from "../../src/lib/ids";
import { seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

async function hmac(actor: SeededTenant, path: string, input?: Record<string, unknown>) {
  const method = input ? "POST" : "GET";
  const body = input && JSON.stringify(input);
  const headers = await signedHeaders({
    apiKey: actor.api_key_plain, hmacSecret: actor.hmac_secret, method, pathname: path, body,
    idempotencyKey: input ? crypto.randomUUID() : undefined,
  });
  return SELF.fetch(`https://example.com${path}`, { method, headers, body });
}

async function customerToken(owner: SeededTenant, customerId: string, scope = ["customer_self"]) {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({
    tenant_id: owner.tenant_id, sub: customerId, scope,
    aud: "grosshandel.api", iss: `tenants:${owner.tenant_id}`, iat, exp: iat + 300,
  }, owner.customer_jwt_secret);
}

async function customer(token: string, path: string, input?: Record<string, unknown>) {
  return SELF.fetch(`https://example.com${path}`, {
    method: input ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "X-Client-Version": "0.1.0", "X-Client-Platform": "ios",
    },
    body: input && JSON.stringify(input),
  });
}

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

interface CaseResult { id: string; version: number }
interface CaseView extends CaseResult {
  lines: Array<{
    id: string;
    qty: number;
    routing?: string;
    current_supplier?: string;
    purchase_line_ref?: string;
    customer: { status: string; settlement?: { document_ref: string; doc_type: string } };
    supplier?: { status: string };
  }>;
}

async function setup() {
  const owner = await seedTenant();
  const supplierA = await seedTenant();
  const supplierB = await seedTenant();
  const customerId = newId("customer");
  const orderId = newId("order");
  const sku = newId("product");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO customers (id, tenant_id, name, country, b2b_b2c, created_at, updated_at)
      VALUES (?, ?, 'Käufer', 'DE', 'b2b', ?, ?)`).bind(customerId, owner.tenant_id, now, now),
    env.DB.prepare(`INSERT INTO orders (id, tenant_id, customer_id, state_current, currency, etag, created_at, updated_at)
      VALUES (?, ?, ?, 'paid', 'EUR', 'test', ?, ?)`).bind(orderId, owner.tenant_id, customerId, now, now),
    env.DB.prepare(`INSERT INTO order_lines (id, order_id, line_no, sku_id, qty, created_at)
      VALUES (?, ?, 1, ?, 10, ?), (?, ?, 2, ?, 5, ?)`)
      .bind(newId("event"), orderId, sku, now, newId("event"), orderId, sku, now),
    env.DB.prepare(`INSERT INTO products (id, tenant_id, sku_code, name, created_at, updated_at)
      VALUES (?, ?, 'FLOWER', 'Ware', ?, ?)`).bind(sku, owner.tenant_id, now, now),
  ]);
  const path = `/v1/orders/${orderId}`;
  const customerPath = `/v1/customer/orders/${orderId}`;
  const partnerPath = `/v1/suppliers/${owner.tenant_id}/orders/${orderId}`;
  const token = await customerToken(owner, customerId);
  const register = (positions: Array<Record<string, unknown>>) =>
    hmac(owner, `${path}/return-deliveries`, { command_id: crypto.randomUUID(), positions });
  const claim = (positions: Array<{ delivery_line_id: string; qty: number }>, kind = "return") =>
    customer(token, `${customerPath}/returns`, { command_id: crypto.randomUUID(), kind, reason: "Beschädigt", positions });
  return { owner, supplierA, supplierB, customerId, orderId, sku, path, customerPath, partnerPath, token, register, claim };
}

describe("Retoure über B2B, Kleinunternehmer und Lieferanten-Edge", () => {
  it("übergibt zwei Lieferpositionen getrennt und liefert bei einem ACK-Verlust denselben Fall", async () => {
    const s = await setup();
    await json(await s.register([
      { delivery_line_id: "leg-a", order_line_no: 1, qty: 4, suppliers: [
        { tenant_id: s.supplierA.tenant_id, purchase_line_ref: "lose-first-ack" },
      ] },
      { delivery_line_id: "leg-b", order_line_no: 1, qty: 5, suppliers: [
        { tenant_id: s.supplierB.tenant_id, purchase_line_ref: "purchase-b" },
      ] },
    ]), 201);
    const delivery = await json<{ items: unknown[] }>(await customer(s.token, `${s.customerPath}/return-deliveries`), 200);
    expect(delivery.items).toEqual([
      { delivery_line_id: "leg-a", order_line_no: 1, qty: 4 },
      { delivery_line_id: "leg-b", order_line_no: 1, qty: 5 },
    ]);
    const created = await json<CaseResult>(await s.claim([{ delivery_line_id: "leg-a", qty: 2 }, { delivery_line_id: "leg-b", qty: 1 }]), 201);
    const path = `${s.path}/returns/${created.id}`;
    const partnerPath = `${s.partnerPath}/returns/${created.id}`;
    const initial = await json<CaseView>(await hmac(s.owner, path), 200);
    const [a, b] = initial.lines;
    if (!a || !b) throw new Error("Expected two return positions");

    const aCommand = { command_id: "forward-a", version: 1, line_id: a.id, type: "handoff", supplier_note: "Welke Blüten" };
    await json(await hmac(s.owner, `${path}/commands`, aCommand), 503);
    const waiting = await json<CaseView>(await hmac(s.owner, path), 200);
    expect(waiting.lines[0]).toMatchObject({ routing: "handoff_pending" });
    expect(waiting.lines[0]?.current_supplier).toBeUndefined();
    const inboxPath = "/v1/suppliers/return-inbox";
    const before = await json<{ items: Array<{ handoff_id: string }> }>(await hmac(s.supplierA, inboxPath), 200);
    expect(before.items).toHaveLength(1);
    await json(await hmac(s.supplierA, partnerPath), 404);

    const bCommand = { command_id: "forward-b", version: 1, line_id: b.id, type: "handoff" };
    const secondLine = await json<CaseResult>(await hmac(s.owner, `${path}/commands`, bCommand), 200);
    expect(secondLine.version).toBe(2);
    const recovered = await json<CaseResult>(await hmac(s.owner, `${path}/commands`, aCommand), 200);
    expect(recovered.version).toBe(3);
    expect(await json(await hmac(s.owner, `${path}/commands`, aCommand), 200)).toEqual(recovered);
    expect(await json(await hmac(s.supplierA, inboxPath), 200)).toEqual(before);

    const aView = await json<CaseView>(await hmac(s.supplierA, partnerPath), 200);
    const bView = await json<CaseView>(await hmac(s.supplierB, partnerPath), 200);
    expect(aView.lines).toMatchObject([{ id: a.id, qty: 2, purchase_line_ref: "lose-first-ack", work: { supplier_note: "Welke Blüten" } }]);
    expect(bView.lines).toMatchObject([{ id: b.id, qty: 1, purchase_line_ref: "purchase-b" }]);
    const command = {
      command_id: "bad-supplier", version: 3, side: "supplier", type: "decide", outcome: "rejected", return_qty: 0,
    };
    await json(await hmac(s.supplierB, `${partnerPath}/commands`, { ...command, line_id: a.id }), 404);
    await json(await hmac(s.supplierA, `${partnerPath}/commands`, { ...command, line_id: a.id }), 200);
    const customerView = await json<CaseView>(await customer(s.token, `${s.customerPath}/returns/${created.id}`), 200);
    expect(customerView.version).toBe(4);
    expect(customerView.lines[0]?.supplier).toBeUndefined();
    expect(aView).not.toHaveProperty("customer_id");
    expect(aView).not.toHaveProperty("evidence_refs");

    const commandFor = (actor: SeededTenant, url: string, input: Record<string, unknown>) =>
      hmac(actor, `${url}/commands`, { command_id: crypto.randomUUID(), line_id: b.id, ...input });
    const warehouse = "wh_returns";
    await json(await commandFor(s.supplierB, partnerPath, {
      version: 4, type: "decide", side: "supplier", outcome: "replacement", return_qty: 1, warehouse_id: warehouse,
    }), 200);
    await json(await commandFor(s.supplierB, partnerPath, {
      version: 5, type: "receive", side: "supplier", receipt_ref: "supplier-receipt", qty: 1,
    }), 200);
    await json(await commandFor(s.supplierB, partnerPath, {
      version: 6, type: "inspect", side: "supplier", receipt_ref: "supplier-receipt", restock_qty: 1, stock_ref: "supplier-stock",
    }), 200);
    await json(await commandFor(s.owner, path, {
      version: 7, type: "decide", side: "customer", outcome: "credit_note", return_qty: 1, warehouse_id: warehouse,
    }), 200);
    await json(await commandFor(s.owner, path, {
      version: 8, type: "receive", side: "customer", receipt_ref: "transit-receipt", qty: 1,
    }), 200);
    const doubled = await json<{ reason: string }>(await commandFor(s.owner, path, {
      version: 9, type: "inspect", side: "customer", receipt_ref: "transit-receipt", restock_qty: 1,
    }), 409);
    expect(doubled.reason).toBe("stock_release_exceeds_claim");
    await json(await commandFor(s.owner, path, {
      version: 9, type: "inspect", side: "customer", receipt_ref: "transit-receipt", restock_qty: 0,
    }), 200);
  }, 15_000);

  it("begrenzt gleichzeitige Teilretouren, prüft die Eigentümerschaft und klärt fehlende Beschaffung", async () => {
    const s = await setup();
    await json(await s.register([{ delivery_line_id: "manual", order_line_no: 1, qty: 4 }]), 201);
    await json(await s.register([{ delivery_line_id: "too-many", order_line_no: 1, qty: 7 }]), 409);
    const withoutClientHeaders = await SELF.fetch(`https://example.com${s.customerPath}/returns`, {
      headers: { Authorization: `Bearer ${s.token}` },
    });
    const clientError = await json<{ reason: string }>(withoutClientHeaders, 400);
    expect(clientError.reason).toBe("X-Client-Version + X-Client-Platform required");
    const positions = [{ delivery_line_id: "manual", qty: 3 }];
    const results = await Promise.all([s.claim(positions, "complaint"), s.claim(positions, "complaint")]);
    expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
    const created = await json<CaseResult>(results.find(({ status }) => status === 201)!, 201);
    const path = `${s.path}/returns/${created.id}`;
    const view = await json<CaseView>(await hmac(s.owner, path), 200);
    const line = view.lines[0]!;
    expect(line.routing).toBe("manual_review");
    await json(await hmac(s.supplierA, path), 404);
    const stranger = await customerToken(s.owner, newId("customer"));
    await json(await customer(stranger, `${s.customerPath}/returns/${created.id}`), 404);
    await json(await customer(stranger, `${s.customerPath}/returns`), 404);
    const readonly = await customerToken(s.owner, s.customerId, ["customer_self.read"]);
    await json(await customer(readonly, `${s.customerPath}/returns`, { command_id: "deny", kind: "return", positions, reason: "Fehler" }), 403);

    const routed = await json<CaseResult>(await hmac(s.owner, `${path}/commands`, {
      command_id: "map", version: 1, line_id: line.id, type: "route",
      suppliers: [
        { tenant_id: s.supplierA.tenant_id, purchase_line_ref: "first" },
        { tenant_id: s.supplierB.tenant_id, purchase_line_ref: "upstream" },
      ],
    }), 200);
    const firstHop = await json<CaseResult>(await hmac(s.owner, `${path}/commands`, {
      command_id: "hop-1", version: routed.version, line_id: line.id, type: "handoff",
    }), 200);
    const supplierPath = `${s.partnerPath}/returns/${created.id}`;
    const nextHop = { command_id: "hop-2", version: firstHop.version, line_id: line.id, type: "handoff" };
    await json(await hmac(s.supplierB, `${supplierPath}/commands`, nextHop), 404);
    await json(await hmac(s.supplierA, `${supplierPath}/commands`, nextHop), 200);
    const upstream = await json<CaseView>(await hmac(s.supplierB, supplierPath), 200);
    expect(upstream.lines).toMatchObject([{ purchase_line_ref: "upstream", qty: 3 }]);
    const forwarded = await json<CaseView>(await hmac(s.supplierA, supplierPath), 200);
    expect(forwarded.lines).toMatchObject([{ state: "forwarded" }]);
    await json(await hmac(s.supplierA, `${supplierPath}/commands`, {
      command_id: "own-decision", version: forwarded.version, line_id: line.id, type: "decide",
      side: "supplier", outcome: "rejected", return_qty: 0,
    }), 200);
    expect(await json(await hmac(s.supplierB, supplierPath), 200)).toMatchObject({
      lines: [{ work: { status: "pending" } }],
    });
  });

  it("schließt Kundengutschriften ohne Rücksendung und bucht geprüften Wareneingang einmal", async () => {
    const s = await setup();
    await json(await s.register([
      { delivery_line_id: "credit", order_line_no: 1, qty: 2 },
      { delivery_line_id: "stock", order_line_no: 2, qty: 3 },
    ]), 201);
    const created = await json<CaseResult>(await s.claim([
      { delivery_line_id: "credit", qty: 1 }, { delivery_line_id: "stock", qty: 2 },
    ], "complaint"), 201);
    const path = `${s.path}/returns/${created.id}`;
    const view = await json<CaseView>(await hmac(s.owner, path), 200);
    const [credit, stock] = view.lines;
    if (!credit || !stock) throw new Error("Expected two return positions");

    const command = (input: Record<string, unknown>) => hmac(s.owner, `${path}/commands`, { side: "customer", ...input });
    const settle = { command_id: "settle", version: 2, line_id: credit.id, type: "settle", booking_ref: "erp-line-1", document_ref: "cn-42" };
    await json(await command({
      command_id: "no-physical", version: 1, line_id: credit.id, type: "decide", outcome: "credit_note", return_qty: 0,
    }), 200);
    await json(await command(settle), 200);
    await json(await command({ ...settle, document_ref: "cn-43" }), 409);
    await json(await command({ ...settle, command_id: "new-id" }), 409);
    await json(await command({
      command_id: "warehouse", version: 3, line_id: stock.id, type: "decide", outcome: "replacement", return_qty: 2, warehouse_id: "wh_returns",
    }), 200);
    await json(await command({
      command_id: "too-large", version: 4, line_id: stock.id, type: "receive", receipt_ref: "oversize", qty: 3,
    }), 409);
    await json(await command({
      command_id: "goods-in", version: 4, line_id: stock.id, type: "receive", receipt_ref: "warehouse-1", qty: 2,
    }), 200);
    const stockPath = `/v1/stock/state?warehouse_id=wh_returns&sku_id=${s.sku}`;
    expect(await json(await hmac(s.owner, stockPath), 200)).toMatchObject({ available: 0 });
    const inspection = {
      command_id: "quality", version: 5, line_id: stock.id, type: "inspect", receipt_ref: "warehouse-1", restock_qty: 1,
    };
    const results = await Promise.all([command(inspection), command(inspection)]);
    for (const result of results) expect(await json<CaseResult>(result, 200)).toEqual({ id: created.id, version: 6 });
    expect(await json(await hmac(s.owner, stockPath), 200)).toMatchObject({ available: 1 });
    const current = await json<CaseView>(await hmac(s.owner, path), 200);
    expect(current.lines[0]?.customer).toMatchObject({ status: "closed", settlement: { document_ref: "cn-42", doc_type: "credit_note" } });
    expect(current.lines[0]?.supplier?.status).toBe("pending");
    expect(current.lines[1]?.customer.status).toBe("approved");
  });

  it("gibt verderbliche Ware erst nach Prüfung mit gültigem MHD als Charge frei", async () => {
    const s = await setup();
    await env.DB.prepare("UPDATE products SET is_perishable = 1 WHERE id = ?").bind(s.sku).run();
    await json(await s.register([{ delivery_line_id: "flowers", order_line_no: 1, qty: 2 }]), 201);
    const created = await json<CaseResult>(await s.claim([{ delivery_line_id: "flowers", qty: 2 }]), 201);
    const path = `${s.path}/returns/${created.id}`;
    const current = await json<CaseView>(await hmac(s.owner, path), 200);
    const line = current.lines[0]!;
    const command = (input: Record<string, unknown>) =>
      hmac(s.owner, `${path}/commands`, { line_id: line.id, side: "customer", ...input });
    await json(await command({
      command_id: "decide", version: 1, type: "decide", outcome: "credit_note", warehouse_id: "wh_returns", return_qty: 2,
    }), 200);
    await json(await command({ command_id: "received", version: 2, type: "receive", receipt_ref: "fresh", qty: 2 }), 200);
    const inspect = { command_id: "inspect", version: 3, type: "inspect", receipt_ref: "fresh", restock_qty: 2 };
    await json(await command({ ...inspect, best_before: "2000-01-01" }), 409);
    const bestBefore = new Date(Date.now() + 86_400_000 * 14).toISOString().slice(0, 10);
    const result = await json(await command({ ...inspect, best_before: bestBefore }), 200);
    expect(await json(await command({ ...inspect, best_before: bestBefore }), 200)).toEqual(result);
    const { results } = await env.DB.prepare("SELECT qty, mhd, status FROM stock_batches WHERE tenant_id = ? AND sku_id = ?")
      .bind(s.owner.tenant_id, s.sku).all();
    expect(results).toEqual([{ qty: 2, mhd: bestBefore, status: "active" }]);
  });
});
