/**
 * M19 — Betriebs-Einstieg für den StockDO-Rebuild (Queue-Auftrag, intern).
 *
 * Getrennt von stock-rebuild.ts (reine Berechnung + Stub-Aufruf). Liest ohne
 * mitgegebenen Plan stock_movements/stock_batches aus D1, ruft rebuildStockDO
 * und protokolliert das Ergebnis strukturiert. Ohne `force` bleiben abweichende
 * DO-Zustände unberührt (Ergebnis "exists").
 */
import type { Env, StockRebuildMessage } from "../env";
import { computeStockTargets, rebuildStockDO, type BatchRow, type MovementRow, type RebuildResult } from "./stock-rebuild";

export interface StockRebuildSummary {
  total: number;
  rebuilt: number;
  unchanged: number;
  exists: number;
  results: RebuildResult[];
}

export async function runStockRebuild(env: Env, msg: StockRebuildMessage): Promise<StockRebuildSummary> {
  let targets = msg.targets;
  if (!targets) {
    const m = await env.DB.prepare("SELECT tenant_id, warehouse_id, sku_id, type, qty_delta FROM stock_movements").all<MovementRow>();
    const b = await env.DB.prepare("SELECT tenant_id, warehouse_id, sku_id, qty, status FROM stock_batches").all<BatchRow>();
    targets = computeStockTargets(m.results, b.results);
  }
  const results = await rebuildStockDO(env, targets, { force: msg.force === true });
  const count = (o: RebuildResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  const summary: StockRebuildSummary = {
    total: results.length, rebuilt: count("rebuilt"), unchanged: count("unchanged"), exists: count("exists"), results,
  };
  console.log(JSON.stringify({
    event: "stock.rebuild", force: msg.force === true, source: msg.targets ? "plan" : "d1",
    total: summary.total, rebuilt: summary.rebuilt, unchanged: summary.unchanged, exists: summary.exists,
  }));
  return summary;
}
