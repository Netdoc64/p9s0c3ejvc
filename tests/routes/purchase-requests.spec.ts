import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANDLERS } from "../../src/orchestrator/handlers";
import type { OrderDoc } from "../../src/schemas/order";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const BASE = "https://example.com";
let t: SeededTenant;
const now = () => new Date().toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

beforeEach(async () => { t = await seedTenant({ slug: "po-a" }); });
afterEach(async () => {
  await env.DB.prepare("DELETE FROM products").run();
  await env.DB.prepare("DELETE FROM stock_movements").run();
  await clearTenants();
});

// Eigener Zeitstempel je Aufruf: zwei gleiche POSTs in derselben Sekunde wären sonst ein Replay (401).
let tick = 0;
async function api(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000) - 120 + (tick++ % 100);
  const headers = await signedHeaders({ apiKey: t.api_key_plain, hmacSecret: t.hmac_secret, method, pathname: path, body: raw, timestamp });
  return SELF.fetch(`${BASE}${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
}

async function product(id: string, perishable: number) {
  await env.DB.prepare(`INSERT INTO products (id, tenant_id, sku_code, name, tax_class, is_perishable, min_order_qty, packaging_units, attributes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'reduced', ?, 1, '[]', '{}', 'active', ?, ?)`).bind(id, t.tenant_id, id.toUpperCase(), `Artikel ${id}`, perishable, now(), now()).run();
}

async function source(sku: string, available: number, opts: { pack?: number; expires?: string } = {}) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO product_sources (tenant_id, sku_id, provider, connection, source_ref, pack_factor, created_at) VALUES (?, ?, 'file-import', 'lieferant-a', ?, ?, ?)")
      .bind(t.tenant_id, sku, `REF-${sku}`, opts.pack ?? 1, now()),
    env.DB.prepare(`INSERT INTO product_sourcing_state (tenant_id, sku_id, provider, connection, source_ref, cost_cents, price_cents, available_units, expires_at, reason, computed_at)
      VALUES (?, ?, 'file-import', 'lieferant-a', ?, ?, 99, ?, ?, 'cheapest', ?)`).bind(t.tenant_id, sku, `REF-${sku}`, 30 * (opts.pack ?? 1), available, opts.expires ?? future(), now()),
  ]);
}

function doc(lines: Array<{ sku_id: string; qty: number }>): OrderDoc {
  return {
    meta: { schema_version: "order-document/1.0", doc_type: "order", id: "ord_po1", tenant_id: t.tenant_id, parent_order_id: null },
    customer_id: "cust_x",
    lines: lines.map((l, i) => ({ ...l, line_no: i + 1, unit_price_cents: 99, tax_scheme: null, tax_rate_pct: null, tax_rule_id: null, line_total_cents: 99 * l.qty, reservation_id: null, resolution: {} })),
    totals: { subtotal_cents: 0, tax_cents: 0, total_cents: 0, currency: "EUR" },
    state: { current: "awaiting_confirmation", history: [] },
    plan: { next_steps: [], executed_steps: [] },
    external_refs: {}, issues: { blocking: [], warnings: [] }, gates_log: {}, audit: {},
  } as unknown as OrderDoc;
}

const run = (type: keyof typeof HANDLERS, d: OrderDoc) =>
  HANDLERS[type](d, { env: env as never, step: { id: `s_${type}`, type: type as never, args: {} }, now: now() });

describe("Quellenmix Teil 2: Kundenbestellung aus Lieferanten-Quelle", () => {
  it("ohne eigenen Bestand, aber mit Quelle: Position kommt aus dem Lieferanten statt die Bestellung anzuhalten", async () => {
    await product("sku_frisch", 1);
    await product("sku_vase", 0);
    await source("sku_frisch", 50);
    await source("sku_vase", 50, { pack: 10 });
    const { doc: reserved, blocked } = await run("reserve_stock", doc([{ sku_id: "sku_frisch", qty: 5 }, { sku_id: "sku_vase", qty: 2 }]));
    expect(blocked).toBeFalsy();
    expect(reserved.lines.every((l) => (l.resolution as { sourcing?: unknown }).sourcing)).toBe(true);
    expect(reserved.lines.every((l) => !l.reservation_id)).toBe(true);

    const { doc: committed } = await run("commit_stock", reserved);
    expect(committed.state.current).toBe("confirmed");
    const reqs = await env.DB.prepare("SELECT sku_id, qty, source_qty, cost_cents, status FROM supplier_purchase_requests ORDER BY line_no").all();
    expect(reqs.results).toEqual([
      { sku_id: "sku_frisch", qty: 5, source_qty: 5, cost_cents: 30, status: "open" },
      { sku_id: "sku_vase", qty: 2, source_qty: 20, cost_cents: 30, status: "open" },
    ]);

    // Wiederholung legt nichts doppelt an
    await run("commit_stock", reserved);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM supplier_purchase_requests").first<{ n: number }>())?.n).toBe(2);
  });

  it("zu wenig Menge bei der Quelle oder abgelaufene Quelle: Bestellung hält wie bisher an", async () => {
    await product("sku_a", 0);
    await source("sku_a", 3);
    const { blocked } = await run("reserve_stock", doc([{ sku_id: "sku_a", qty: 5 }]));
    expect(blocked).toBe(true);
    await env.DB.prepare("UPDATE product_sourcing_state SET available_units = 100, expires_at = ?").bind("2000-01-01T00:00:00.000Z").run();
    expect((await run("reserve_stock", doc([{ sku_id: "sku_a", qty: 5 }]))).blocked).toBe(true);
  });

  it("eigener Bestand geht vor: dann keine Anforderung", async () => {
    await product("sku_b", 0);
    await source("sku_b", 50);
    const { adjust } = await import("../../src/services/stock");
    await adjust(env as never, { tenant_id: t.tenant_id, warehouse_id: "wh_default", sku_id: "sku_b", qty_delta: 10, reason: "test" });
    const { doc: reserved } = await run("reserve_stock", doc([{ sku_id: "sku_b", qty: 5 }]));
    expect(reserved.lines[0]?.reservation_id).toBeTruthy();
    await run("commit_stock", reserved);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM supplier_purchase_requests").first<{ n: number }>())?.n).toBe(0);
  });

  it("Storno der Kundenbestellung: offene Anforderungen fallen weg, gesendete brauchen einen Menschen", async () => {
    await product("sku_c", 0);
    await product("sku_d", 0);
    await source("sku_c", 50);
    await source("sku_d", 50);
    const { doc: reserved } = await run("reserve_stock", doc([{ sku_id: "sku_c", qty: 1 }, { sku_id: "sku_d", qty: 1 }]));
    await run("commit_stock", reserved);
    await env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'sent' WHERE sku_id = 'sku_d'").run();
    await run("release_stock", { ...reserved, state: { current: "confirmed", history: [] } } as unknown as OrderDoc);
    const st = await env.DB.prepare("SELECT sku_id, status FROM supplier_purchase_requests ORDER BY sku_id").all();
    expect(st.results).toEqual([{ sku_id: "sku_c", status: "cancelled" }, { sku_id: "sku_d", status: "cancel_requested" }]);
  });

  it("Liste, Bestellliste als CSV, Senden (Datei-Lieferant) und Abbrechen über die API", async () => {
    await product("sku_e", 0);
    await product("sku_f", 0);
    await source("sku_e", 50);
    await source("sku_f", 50);
    const { doc: reserved } = await run("reserve_stock", doc([{ sku_id: "sku_e", qty: 3 }, { sku_id: "sku_f", qty: 4 }]));
    await run("commit_stock", reserved);

    const list = (await (await api("GET", "/v1/purchase-orders?status=open")).json()) as { items: Array<{ id: string; sku_id: string; sku_name: string }> };
    expect(list.items).toHaveLength(2);
    expect(list.items.find((i) => i.sku_id === "sku_e")?.sku_name).toBe("Artikel sku_e");

    const csv = await api("GET", "/v1/purchase-orders/export?connection=lieferant-a");
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(await csv.text()).toBe("sku;menge;positionen\nREF-sku_e;3;1\nREF-sku_f;4;1\n");

    const e = list.items.find((i) => i.sku_id === "sku_e")!;
    const f = list.items.find((i) => i.sku_id === "sku_f")!;
    expect(await (await api("POST", `/v1/purchase-orders/${e.id}/send`)).json()).toMatchObject({ status: "sent" });
    expect((await api("POST", `/v1/purchase-orders/${e.id}/send`)).status).toBe(409);
    expect(await (await api("POST", `/v1/purchase-orders/${f.id}/cancel`)).json()).toMatchObject({ status: "cancelled" });
  });
});

describe("Review-Funde: Einkauf", () => {
  it("dieselbe Lieferantenmenge wird nicht zweimal zugesagt", async () => {
    await product("sku_g", 0);
    await source("sku_g", 50);
    const first = await run("reserve_stock", doc([{ sku_id: "sku_g", qty: 40 }]));
    await run("commit_stock", first.doc);
    const second = await run("reserve_stock", { ...doc([{ sku_id: "sku_g", qty: 40 }]), meta: { ...doc([]).meta, id: "ord_po2" } } as OrderDoc);
    expect(second.blocked).toBe(true);
  });

  it("ist die Quelle beim Bestätigen weg, hält die Bestellung an statt zu bestätigen", async () => {
    await product("sku_h", 0);
    await source("sku_h", 50);
    const { doc: reserved } = await run("reserve_stock", doc([{ sku_id: "sku_h", qty: 5 }]));
    await env.DB.prepare("UPDATE product_sourcing_state SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const res = await run("commit_stock", reserved);
    expect(res.blocked).toBe(true);
    expect(res.doc.state.current).toBe("on_hold");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM supplier_purchase_requests").first<{ n: number }>())?.n).toBe(0);
  });

  it("CSV entschärft Formeln, ungültiger Quellname wird abgewiesen", async () => {
    await product("sku_i", 0);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO product_sources (tenant_id, sku_id, provider, connection, source_ref, pack_factor, created_at) VALUES (?, 'sku_i', 'file-import', 'lieferant-a', '=HYPERLINK(1)', 1, ?)").bind(t.tenant_id, now()),
      env.DB.prepare(`INSERT INTO product_sourcing_state (tenant_id, sku_id, provider, connection, source_ref, cost_cents, price_cents, available_units, expires_at, reason, computed_at)
        VALUES (?, 'sku_i', 'file-import', 'lieferant-a', '=HYPERLINK(1)', 30, 99, 10, ?, 'cheapest', ?)`).bind(t.tenant_id, future(), now()),
    ]);
    const { doc: reserved } = await run("reserve_stock", doc([{ sku_id: "sku_i", qty: 1 }]));
    await run("commit_stock", reserved);
    const csv = await (await api("GET", "/v1/purchase-orders/export?connection=lieferant-a")).text();
    expect(csv).toContain("'=HYPERLINK(1);1;1");
    expect((await api("GET", "/v1/purchase-orders/export?connection=a%22b")).status).toBe(400);
  });
});
