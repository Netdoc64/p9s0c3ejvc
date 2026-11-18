/**
 * M14 — End-to-End Smoke
 * Erfordert: Worker läuft (`pnpm dev`) UND `pnpm seed:pilot` ausgeführt.
 *
 * Verwendung:
 *   GROSSHANDEL_BASE_URL=http://127.0.0.1:8787 \
 *   GROSSHANDEL_API_KEY=gh_... \
 *   GROSSHANDEL_HMAC_SECRET=... \
 *     pnpm smoke
 */

import { createHash, createHmac } from "node:crypto";

const baseUrl = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.GROSSHANDEL_API_KEY;
const hmacSecret = process.env.GROSSHANDEL_HMAC_SECRET;

if (!apiKey || !hmacSecret) {
  console.error("Bitte GROSSHANDEL_API_KEY und GROSSHANDEL_HMAC_SECRET setzen (aus seed-pilot-Output).");
  process.exit(1);
}

function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function signedHeaders(method: string, pathWithSearch: string, body: string, idempotencyKey?: string): Record<string, string> {
  // pathWithSearch enthält pathname inkl. Query-String (#A-002).
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = sha256Hex(body);
  const signing = `${method}\n${pathWithSearch}\n${ts}\n${bodyHash}`;
  const sig = createHmac("sha256", hmacSecret as string).update(signing).digest("hex");
  const h: Record<string, string> = {
    "X-Api-Key": apiKey as string,
    "X-Signature": sig,
    "X-Timestamp": ts,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) h["X-Idempotency-Key"] = idempotencyKey;
  return h;
}

async function main(): Promise<void> {
  // 1. /health
  const h = await fetch(`${baseUrl}/health`);
  if (h.status !== 200) throw new Error(`health failed ${h.status}`);
  console.log("✓ /health");

  // 2. Search products
  const search = await fetch(`${baseUrl}/v1/products/search?q=rose`, { headers: signedHeaders("GET", "/v1/products/search?q=rose", "") });
  if (search.status !== 200) throw new Error(`search ${search.status}`);
  const items = (await search.json() as { items: Array<{ id: string }> }).items;
  if (items.length === 0) throw new Error("search returned no items");
  const skuId = items[0]?.id as string;
  console.log(`✓ /v1/products/search (${items.length} items)`);

  // Je Lauf eindeutige Idempotency-Keys: mit festen Keys lieferte ein zweiter
  // Lauf nur die zwischengespeicherte Antwort des ersten und prüfte nichts.
  const run = Date.now().toString(36);

  // 3. Wareneingang. Der Seed schreibt nur Audit-Zeilen in stock_movements;
  //    echten Bestand (Charge in D1 + Zähler im Stock-DO) legt nur dieser Weg
  //    an. Ohne ihn scheitert die Bestellung an FEFO (GH-FEFO-001).
  const mhd = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const receiveBody = JSON.stringify({ warehouse_id: "wh_main", sku_id: skuId, qty: 100, mhd, notes: "smoke" });
  const receive = await fetch(`${baseUrl}/v1/stock/batches`, {
    method: "POST",
    headers: signedHeaders("POST", "/v1/stock/batches", receiveBody, `smoke-receive-${run}`),
    body: receiveBody,
  });
  if (receive.status !== 201) {
    const err = await receive.text();
    throw new Error(`receive ${receive.status}: ${err}`);
  }
  console.log(`✓ POST /v1/stock/batches (100 Stück, MHD ${mhd})`);

  // 4. Create order
  const orderBody = JSON.stringify({
    customer_id: "cust_floraly_de",
    lines: [{ sku_id: skuId, qty: 10, warehouse_id: "wh_main" }],
  });
  const create = await fetch(`${baseUrl}/v1/orders`, {
    method: "POST",
    headers: signedHeaders("POST", "/v1/orders", orderBody, `smoke-create-${run}`),
    body: orderBody,
  });
  if (create.status !== 201) {
    const err = await create.text();
    throw new Error(`create ${create.status}: ${err}`);
  }
  const created = (await create.json() as { doc: { meta: { id: string }; state: { current: string } }; etag: string });
  const orderId = created.doc.meta.id;
  console.log(`✓ POST /v1/orders → ${orderId} (state=${created.doc.state.current})`);

  // 5. Confirm
  const confirmPath = `/v1/orders/${orderId}/confirm`;
  const confirm = await fetch(`${baseUrl}${confirmPath}`, {
    method: "POST",
    headers: signedHeaders("POST", confirmPath, "", `smoke-confirm-${run}`),
  });
  if (confirm.status !== 200) {
    const err = await confirm.text();
    throw new Error(`confirm ${confirm.status}: ${err}`);
  }
  const confirmed = await confirm.json() as { doc: { state: { current: string }; external_refs: Record<string, unknown>; plan: { next_steps: unknown[] } } };
  console.log(`✓ POST /v1/orders/:id/confirm → state=${confirmed.doc.state.current}`);

  // 6. Die Bestätigung muss bis zur Rechnung durchlaufen (commit_stock →
  //    emit_event → generate_invoice). Bis 2026-11-17 brach sie nach dem Event
  //    ab, und keine Bestellung bekam je eine Rechnung — „confirmed“ allein
  //    sah trotzdem grün aus.
  const invoiceNumber = confirmed.doc.external_refs.invoice_number;
  if (!invoiceNumber) {
    throw new Error(`keine Rechnung erzeugt; offene Schritte: ${JSON.stringify(confirmed.doc.plan.next_steps)}`);
  }
  console.log(`✓ Rechnung ${String(invoiceNumber)} erzeugt`);

  // 7. Zu wenig Bestand ist ein Geschäftszustand, kein Absturz: 201 mit
  //    on_hold und dem Grund in issues.blocking. Bis 2026-11-17 kam 422, und
  //    das Dokument blieb trotzdem als `resolving` liegen.
  const tooMuchBody = JSON.stringify({ customer_id: "cust_floraly_de", lines: [{ sku_id: skuId, qty: 99_999, warehouse_id: "wh_main" }] });
  const tooMuch = await fetch(`${baseUrl}/v1/orders`, {
    method: "POST",
    headers: signedHeaders("POST", "/v1/orders", tooMuchBody, `smoke-toomuch-${run}`),
    body: tooMuchBody,
  });
  if (tooMuch.status !== 201) throw new Error(`zu viel bestellt: erwartet 201/on_hold, bekam ${tooMuch.status}: ${await tooMuch.text()}`);
  const held = await tooMuch.json() as { doc: { state: { current: string }; issues: { blocking: Array<{ code: string }> } } };
  if (held.doc.state.current !== "on_hold" || !held.doc.issues.blocking.some((b) => b.code === "GH-FEFO-001")) {
    throw new Error(`zu viel bestellt: erwartet on_hold mit GH-FEFO-001, bekam ${held.doc.state.current} ${JSON.stringify(held.doc.issues.blocking)}`);
  }
  console.log("✓ Zu wenig Bestand → on_hold mit GH-FEFO-001");

  console.log("\n✓ Smoke OK");
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});

export {};
