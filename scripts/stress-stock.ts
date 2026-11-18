/**
 * Stresstest Bestand (DEPLOYMENT.md-Checkliste): N parallele Bestellungen à 1
 * Stück auf eine Charge mit K Stück. Erwartet: genau K gehen auf
 * awaiting_confirmation, der Rest auf on_hold — nie mehr als K reserviert.
 * Danach werden die angenommenen Bestellungen storniert (Bestand zurück).
 *
 * Erfordert GROSSHANDEL_BASE_URL, GROSSHANDEL_API_KEY, GROSSHANDEL_HMAC_SECRET.
 * Optional: STRESS_SKU (Vorgabe: zweiter Treffer für "tulip"), STRESS_N=100, STRESS_K=50.
 */
import { createHash, createHmac } from "node:crypto";

const baseUrl = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.GROSSHANDEL_API_KEY;
const hmacSecret = process.env.GROSSHANDEL_HMAC_SECRET;
const N = Number(process.env.STRESS_N ?? 100);
const K = Number(process.env.STRESS_K ?? 50);
if (!apiKey || !hmacSecret) { console.error("Bitte GROSSHANDEL_API_KEY und GROSSHANDEL_HMAC_SECRET setzen."); process.exit(1); }

function headers(method: string, path: string, body: string, idem?: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", hmacSecret as string).update(`${method}\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  return { "X-Api-Key": apiKey as string, "X-Signature": sig, "X-Timestamp": ts, "Content-Type": "application/json", ...(idem ? { "X-Idempotency-Key": idem } : {}) };
}
async function call(method: string, path: string, body = "", idem?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: headers(method, path, body, idem), body: body || undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main(): Promise<void> {
  const run = Date.now().toString(36);
  // Frische SKU ohne Bestand: eigene Charge mit genau K Stück anlegen.
  let sku = process.env.STRESS_SKU;
  if (!sku) {
    const s = await call("GET", "/v1/products/search?q=tulip");
    sku = s.json?.items?.[1]?.id ?? s.json?.items?.[0]?.id;
  }
  if (!sku) throw new Error("keine SKU gefunden");
  const before = await call("GET", `/v1/stock/batches?sku_id=${sku}`);
  const already = (before.json?.items ?? []).reduce((n: number, b: { qty_remaining?: number; qty?: number }) => n + (b.qty_remaining ?? b.qty ?? 0), 0);
  if (already > 0) throw new Error(`${sku} hat schon ${already} Stück — STRESS_SKU auf eine SKU ohne Bestand setzen`);
  const mhd = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const rb = JSON.stringify({ warehouse_id: "wh_main", sku_id: sku, qty: K, mhd, notes: "stress" });
  const r = await call("POST", "/v1/stock/batches", rb, `stress-recv-${run}`);
  if (r.status !== 201) throw new Error(`Wareneingang ${r.status}: ${JSON.stringify(r.json)}`);
  console.log(`Charge: ${K} Stück ${sku}`);

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => {
    const body = JSON.stringify({ customer_id: "cust_floraly_de", lines: [{ sku_id: sku, qty: 1, warehouse_id: "wh_main" }] });
    return call("POST", "/v1/orders", body, `stress-${run}-${i}`);
  }));
  const ms = Date.now() - t0;
  const by = new Map<string, number>();
  for (const x of results) {
    const k = x.status === 201 ? x.json.doc.state.current : `http_${x.status}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  console.log(`${N} parallel in ${ms} ms:`, Object.fromEntries(by));

  const accepted = results.filter((x) => x.status === 201 && x.json.doc.state.current === "awaiting_confirmation");
  for (const a of accepted) {
    const id = a.json.doc.meta.id as string;
    await call("POST", `/v1/orders/${id}/cancel`, JSON.stringify({ reason: "stress-cleanup" }), `stress-cancel-${id}`);
  }
  console.log(`aufgeräumt: ${accepted.length} storniert`);

  if (accepted.length !== K) throw new Error(`erwartet genau ${K} angenommen, waren ${accepted.length}`);
  if ((by.get("on_hold") ?? 0) !== N - K) throw new Error(`erwartet ${N - K} on_hold, waren ${by.get("on_hold") ?? 0}`);
  console.log(`\n✓ Stresstest OK: genau ${K} von ${N} angenommen, ${N - K} on_hold`);
}

main().catch((e) => { console.error("✗ Stresstest failed:", e instanceof Error ? e.message : e); process.exit(1); });
export {};
