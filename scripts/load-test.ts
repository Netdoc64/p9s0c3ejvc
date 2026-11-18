/**
 * Lasttest (DEPLOYMENT.md-Checkliste): gemischter Lesetraffic mit fester
 * Parallelität über eine feste Dauer; misst Latenz-Perzentile und Fehlerquote
 * gegen das SLO aus dem Build-Plan (api_p99_latency_ms = 500).
 *
 * Mix: 50 % Produktsuche, 30 % Preisanfrage, 20 % /health. Schreibt nichts.
 *
 * Erfordert GROSSHANDEL_BASE_URL, GROSSHANDEL_API_KEY, GROSSHANDEL_HMAC_SECRET.
 * Optional: LOAD_CONCURRENCY=20, LOAD_SECONDS=60, LOAD_P99_MS=500.
 */
import { createHash, createHmac } from "node:crypto";

const baseUrl = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.GROSSHANDEL_API_KEY;
const hmacSecret = process.env.GROSSHANDEL_HMAC_SECRET;
const C = Number(process.env.LOAD_CONCURRENCY ?? 20);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
const P99_BUDGET = Number(process.env.LOAD_P99_MS ?? 500);
if (!apiKey || !hmacSecret) { console.error("Bitte GROSSHANDEL_API_KEY und GROSSHANDEL_HMAC_SECRET setzen."); process.exit(1); }

function signed(method: string, path: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", hmacSecret as string).update(`${method}\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  return { "X-Api-Key": apiKey as string, "X-Signature": sig, "X-Timestamp": ts, "Content-Type": "application/json" };
}

const QUERIES = ["rose", "tulip", "naomi", "gerbera", "rot", "40"];
const SKUS = ["sku_rose_naomi_40", "sku_rose_naomi_60", "sku_tulip_pink_40", "sku_tulip_white_50"];

type Sample = { kind: string; ms: number; status: number };

// Je Route und Fehlercode ein Beispiel-Body: ein Lasttest, der nur Statuscodes
// zählt, verrät nie die Ursache.
const errorSamples = new Map<string, { n: number; body: string }>();

async function one(): Promise<Sample> {
  const r = Math.random();
  const t0 = performance.now();
  let kind: string; let res: Response;
  if (r < 0.5) {
    kind = "search";
    const path = `/v1/products/search?q=${QUERIES[Math.floor(Math.random() * QUERIES.length)]}`;
    res = await fetch(`${baseUrl}${path}`, { headers: signed("GET", path, "") });
  } else if (r < 0.8) {
    kind = "quote";
    // on_date mit Millisekunden macht jeden Body eindeutig. Zwei identische
    // POSTs in derselben Sekunde weist der Replay-Schutz (gewollt) mit 401 ab.
    const body = JSON.stringify({ customer_id: "cust_floraly_de", sku_id: SKUS[Math.floor(Math.random() * SKUS.length)], qty: 1 + Math.floor(Math.random() * 60), on_date: new Date().toISOString() });
    res = await fetch(`${baseUrl}/v1/pricing/quote`, { method: "POST", headers: signed("POST", "/v1/pricing/quote", body), body });
  } else {
    kind = "health";
    res = await fetch(`${baseUrl}/health`);
  }
  const ms = performance.now() - t0;
  if (res.status >= 400) {
    const raw = (await res.text()).replace(/"instance":"[^"]*",?/, ""); const body = raw.length > 240 ? `${raw.slice(0, 100)} … ${raw.slice(-140)}` : raw;
    const k = `${kind} ${res.status}`;
    const e = errorSamples.get(k);
    if (e) e.n += 1; else errorSamples.set(k, { n: 1, body });
  } else {
    await res.arrayBuffer();
  }
  return { kind, ms, status: res.status };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

async function main(): Promise<void> {
  const samples: Sample[] = [];
  const end = Date.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: C }, async () => {
    while (Date.now() < end) {
      try { samples.push(await one()); } catch { samples.push({ kind: "net", ms: 0, status: 0 }); }
    }
  }));

  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const errors = samples.length - ok.length;
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  console.log(`${samples.length} Anfragen in ${SECONDS} s bei ${C} parallel = ${(samples.length / SECONDS).toFixed(1)} rps`);
  console.log(`Status: ${JSON.stringify(Object.fromEntries(byStatus))}`);
  for (const kind of ["search", "quote", "health"]) {
    const ms = ok.filter((s) => s.kind === kind).map((s) => s.ms).sort((a, b) => a - b);
    console.log(`  ${kind.padEnd(7)} n=${String(ms.length).padStart(5)}  p50=${pct(ms, 50).toFixed(0)} ms  p95=${pct(ms, 95).toFixed(0)} ms  p99=${pct(ms, 99).toFixed(0)} ms`);
  }
  for (const [k, e] of errorSamples) console.log(`  Fehler ${k}: ${e.n}× — ${e.body}`);
  const all = ok.map((s) => s.ms).sort((a, b) => a - b);
  const p99 = pct(all, 99);
  const errRate = errors / Math.max(1, samples.length);
  console.log(`gesamt  p99=${p99.toFixed(0)} ms (Budget ${P99_BUDGET}), Fehlerquote ${(errRate * 100).toFixed(2)} %`);
  // Gemessen wird vom Client aus: die Zahl enthält den Netzweg hierher.
  if (p99 > P99_BUDGET || errRate > 0.01) { console.error("✗ Lasttest außerhalb des SLO"); process.exit(1); }
  console.log("\n✓ Lasttest im SLO");
}

main().catch((e) => { console.error("✗ Lasttest failed:", e instanceof Error ? e.message : e); process.exit(1); });
export {};
