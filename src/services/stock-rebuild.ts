/**
 * M19 — Rebuild des StockDO-Bestands aus D1.
 *
 * Die Durable Objects sind nicht Teil des D1-Backups. Quelle der Wahrheit für
 * den Neuaufbau ist `stock_movements`: die Summe von `qty_delta` je
 * tenant/warehouse/sku ergibt `available`. reserve/release/auto_release tragen
 * qty_delta 0, offene Reservierungen sind nach einem Verlust des DO nicht
 * rekonstruierbar und werden bewusst verworfen. `stock_batches` (aktive
 * Chargen) dient nur als Gegencheck und ändert den Zielwert nicht.
 *
 * Die reine Berechnung (`computeStockTargets`) hat keine Laufzeit-Abhängigkeit
 * und läuft auch im Skript scripts/rebuild-stock.ts.
 */
import type { Env } from "../env";
import { key } from "./stock";

export interface MovementRow {
  tenant_id: string;
  warehouse_id: string;
  sku_id: string;
  type: string;
  qty_delta: number;
}

export interface BatchRow {
  tenant_id: string;
  warehouse_id: string;
  sku_id: string;
  qty: number;
  status: string;
}

export interface StockTarget {
  /** DO-Schlüssel "tenant/warehouse/sku" (idFromName). */
  key: string;
  scope: { tenant_id: string; warehouse_id: string; sku_id: string };
  available: number;
  movements: number;
  /** Summe aktiver Chargen; null, wenn der Artikel keine Chargen führt. */
  batch_qty: number | null;
  /** batch_qty - available; null ohne Chargen. Hinweis, kein Fehler. */
  batch_drift: number | null;
  warnings: string[];
}

export function computeStockTargets(movements: MovementRow[], batches: BatchRow[]): StockTarget[] {
  const byKey = new Map<string, StockTarget>();
  const scopeOf = (r: { tenant_id: string; warehouse_id: string; sku_id: string }) => ({
    tenant_id: r.tenant_id, warehouse_id: r.warehouse_id, sku_id: r.sku_id,
  });
  const get = (r: { tenant_id: string; warehouse_id: string; sku_id: string }): StockTarget => {
    const k = key(r);
    let t = byKey.get(k);
    if (!t) {
      t = { key: k, scope: scopeOf(r), available: 0, movements: 0, batch_qty: null, batch_drift: null, warnings: [] };
      byKey.set(k, t);
    }
    return t;
  };
  for (const m of movements) {
    const t = get(m);
    t.available += m.qty_delta;
    t.movements += 1;
  }
  for (const b of batches) {
    if (b.status !== "active") continue;
    const t = get(b);
    t.batch_qty = (t.batch_qty ?? 0) + b.qty;
  }
  const out = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const t of out) {
    if (t.batch_qty !== null) {
      t.batch_drift = t.batch_qty - t.available;
      if (t.batch_drift !== 0) t.warnings.push(`Chargen (${t.batch_qty}) weichen vom Bewegungs-Bestand (${t.available}) ab`);
    }
    if (t.available < 0) t.warnings.push(`negativer Bestand ${t.available}`);
  }
  return out;
}

export interface RebuildResult {
  key: string;
  outcome: "rebuilt" | "unchanged" | "exists";
}

/**
 * Setzt den DO-Zustand je Ziel zurück. Läuft nur über den Stub (kein Route-
 * Pfad). Ohne `force` wird ein vorhandener, abweichender Zustand NICHT
 * überschrieben (outcome "exists").
 */
export async function rebuildStockDO(env: Env, targets: StockTarget[], opts: { force?: boolean } = {}): Promise<RebuildResult[]> {
  const results: RebuildResult[] = [];
  for (const t of targets) {
    const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(t.key));
    const res = await stub.fetch("https://stock.local/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ available: t.available, scope: t.scope, force: opts.force === true }),
    });
    const json = (await res.json()) as { changed?: boolean };
    if (res.status === 409) results.push({ key: t.key, outcome: "exists" });
    else if (res.status === 200) results.push({ key: t.key, outcome: json.changed ? "rebuilt" : "unchanged" });
    else throw new Error(`rebuild ${t.key}: HTTP ${res.status}`);
  }
  return results;
}
