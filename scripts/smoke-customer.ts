/**
 * Smoke der Kunden-API (/v1/customer) gegen einen laufenden Worker — so, wie
 * die mobile App sie benutzt: Konto → Katalog → Preis → Bestellung →
 * Bestätigung → Rechnungs-PDF → Auftragsliste.
 *
 * Erfordert:
 *   GROSSHANDEL_BASE_URL       Worker-URL
 *   GROSSHANDEL_CUSTOMER_TOKEN Kunden-Access-Token (Bearer-JWT aus /v1/auth/oauth/token)
 *
 * Braucht bestellbaren Bestand im Standardlager (z. B. nach `pnpm smoke`).
 */
const baseUrl = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.GROSSHANDEL_CUSTOMER_TOKEN;
if (!token) {
  console.error("Bitte GROSSHANDEL_CUSTOMER_TOKEN setzen (Kunden-Access-Token).");
  process.exit(1);
}

const run = Date.now().toString(36);
const base = { Authorization: `Bearer ${token}`, "X-Client-Version": "0.1.0", "X-Client-Platform": "ios" };

async function call(method: string, path: string, body?: unknown, idem?: string): Promise<{ status: number; json: any; res: Response }> {
  const res = await fetch(`${baseUrl}/v1/customer${path}`, {
    method,
    headers: { ...base, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(idem ? { "X-Idempotency-Key": idem } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("Content-Type") ?? "";
  return { status: res.status, json: ct.includes("json") ? await res.clone().json() : null, res };
}

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const me = await call("GET", "/me");
  expect(me.status === 200 && me.json.customer?.id, `me ${me.status} ${JSON.stringify(me.json)}`);
  console.log(`✓ GET /me → ${me.json.customer.id} bei ${me.json.merchant.name}`);

  const noHeaders = await fetch(`${baseUrl}/v1/customer/me`, { headers: { Authorization: `Bearer ${token}` } });
  expect(noHeaders.status === 400, `ohne Client-Header erwartet 400, bekam ${noHeaders.status}`);
  console.log("✓ ohne X-Client-Version → 400");

  const prods = await call("GET", "/products?q=rose");
  const sku = prods.json?.items?.[0]?.id as string | undefined;
  expect(prods.status === 200 && sku, `products ${prods.status}`);
  console.log(`✓ GET /products?q=rose → ${prods.json.items.length} Artikel`);

  const quote = await call("POST", "/quotes", { sku_id: sku, qty: 3 });
  expect(quote.status === 200 && quote.json.total_cents === quote.json.unit_price_cents * 3, `quote ${quote.status} ${JSON.stringify(quote.json)}`);
  console.log(`✓ POST /quotes → ${quote.json.unit_price_cents} ct/Stück, ${quote.json.total_cents} ct`);

  const draftBody = { lines: [{ sku_id: sku, qty: 3 }] };
  const draft = await call("POST", "/orders", draftBody, `cust-smoke-${run}`);
  expect(draft.status === 201 && draft.json.state === "awaiting_confirmation", `order ${draft.status} ${JSON.stringify(draft.json)}`);
  expect(draft.json.plan === undefined && draft.json.audit === undefined, "Bestellung enthält interne Felder (plan/audit)");
  console.log(`✓ POST /orders → ${draft.json.id} (${draft.json.state}), Aktionen ${draft.json.allowed_actions.join("+")}`);

  const again = await call("POST", "/orders", draftBody, `cust-smoke-${run}`);
  expect(again.status === 201 && again.json.id === draft.json.id, `Wiederholung mit gleichem Idempotency-Key erzeugte ${again.json?.id} statt ${draft.json.id}`);
  console.log("✓ Wiederholung mit gleichem Idempotency-Key → derselbe Auftrag");

  const conf = await call("POST", `/orders/${draft.json.id}/confirm`, undefined, `cust-confirm-${run}`);
  expect(conf.status === 200 && conf.json.state === "confirmed" && conf.json.invoice?.number, `confirm ${conf.status} ${JSON.stringify(conf.json)}`);
  expect(!conf.json.allowed_actions.includes("cancel"), "bestätigte Bestellung bietet dem Kunden noch Storno an");
  console.log(`✓ POST /orders/:id/confirm → confirmed, Rechnung ${conf.json.invoice.number}`);

  const pdf = await call("GET", `/orders/${draft.json.id}/invoice`);
  const bytes = new Uint8Array(await pdf.res.arrayBuffer());
  expect(pdf.status === 200 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-", `invoice ${pdf.status}`);
  console.log(`✓ GET /orders/:id/invoice → PDF, ${bytes.byteLength} Byte`);

  const list = await call("GET", "/orders?limit=5");
  expect(list.status === 200 && list.json.items.some((o: { id: string }) => o.id === draft.json.id), "Auftragsliste enthält den neuen Auftrag nicht");
  console.log(`✓ GET /orders → ${list.json.items.length} eigene Aufträge`);

  const missing = await call("GET", "/orders/ord_00000000000000000000000000");
  expect(missing.status === 404, `unbekannter Auftrag: erwartet 404, bekam ${missing.status}`);
  console.log("✓ unbekannter Auftrag → 404");

  console.log("\n✓ Kunden-API-Smoke OK");
}

main().catch((err) => {
  console.error("✗ Kunden-API-Smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

export {};
