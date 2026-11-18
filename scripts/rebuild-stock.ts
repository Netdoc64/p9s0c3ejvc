/**
 * M19 — Plan für den Neuaufbau des StockDO-Bestands aus D1.
 *
 * Liest stock_movements und stock_batches (Standard: lokale D1, `--local`),
 * berechnet je tenant/warehouse/sku den Zielbestand (services/stock-rebuild.ts)
 * und gibt Plan + Abweichungen zu den aktiven Chargen aus. Schreibt NICHTS:
 * weder in D1 noch in Durable Objects, kein Deploy. Das Einspielen in die DOs
 * geschieht über rebuildStockDO() (nur per Stub, siehe Runbook disaster-restore).
 *
 * Verwendung:
 *   pnpm tsx scripts/rebuild-stock.ts [--db <d1-name>] [--remote] [--env <env>] [--out plan.json]
 * `--remote` liest nur (SELECT); ohne Angabe wird die lokale D1 gelesen.
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { computeStockTargets, type BatchRow, type MovementRow } from "../src/services/stock-rebuild";

const { values } = parseArgs({
  options: {
    db: { type: "string", default: "DB" },
    remote: { type: "boolean", default: false },
    env: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});

const wranglerJs = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
const where = values.remote ? "--remote" : "--local";
const envArgs = values.env ? ["--env", values.env] : [];

function query<T>(sql: string): T[] {
  const out = execFileSync(
    process.execPath,
    [wranglerJs, "d1", "execute", values.db as string, where, ...envArgs, "--json", "--command", sql],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
  return (JSON.parse(out) as Array<{ results: T[] }>)[0]?.results ?? [];
}

const movements = query<MovementRow>("SELECT tenant_id, warehouse_id, sku_id, type, qty_delta FROM stock_movements");
const batches = query<BatchRow>("SELECT tenant_id, warehouse_id, sku_id, qty, status FROM stock_batches");
const targets = computeStockTargets(movements, batches);

console.log(`Quelle: ${where === "--remote" ? "remote (nur lesend)" : "lokale D1"}, ${movements.length} Bewegungen, ${batches.length} Chargen`);
console.log(`Plan: ${targets.length} StockDO-Schlüssel\n`);
for (const t of targets) {
  const batch = t.batch_qty === null ? "-" : String(t.batch_qty);
  console.log(`${t.key}\tavailable=${t.available}\tbewegungen=${t.movements}\tchargen=${batch}${t.warnings.length ? `\t⚠ ${t.warnings.join("; ")}` : ""}`);
}
const warned = targets.filter((t) => t.warnings.length > 0).length;
console.log(`\n${targets.length} Ziele, ${warned} mit Hinweis. Offene Reservierungen sind nicht rekonstruierbar und werden verworfen.`);
if (values.out) {
  writeFileSync(values.out, JSON.stringify(targets, null, 2));
  console.log(`Plan geschrieben: ${values.out}`);
}
