/**
 * Bestellbare Menge je Artikel für den Kundenkatalog.
 *
 * Eine Kundenposition kommt GANZ aus dem eigenen Lager oder GANZ aus der
 * gewählten Lieferanten-Quelle (siehe sourcing/fulfil.ts) — sie wird nicht
 * geteilt. Bestellbar ist deshalb das MAXIMUM beider Mengen, nicht die Summe:
 * 5 im Lager und 50 beim Lieferanten heißt „bis 50 auf einmal“, nicht 55.
 *
 * Eigenbestand = verfügbare Menge im Standardlager (dasselbe Lager, aus dem
 * Kundenbestellungen reservieren). Lieferant = zuletzt gewählte, noch gültige
 * Quelle. Schlägt die Abfrage fehl, ist die Menge unbekannt (null), nie 0.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { warehouses } from "../db/schema/stock";
import * as stockSvc from "../services/stock";

export async function availableQuantities(env: Env, tenantId: string, skuIds: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  if (!skuIds.length) return out;
  const db = getDb(env.DB);
  const wh = (await db.select({ id: warehouses.id }).from(warehouses)
    .where(and(eq(warehouses.tenant_id, tenantId), eq(warehouses.is_default, 1))).limit(1))[0]?.id ?? "wh_default";
  const marks = skuIds.map(() => "?").join(",");
  const [moved, supplied] = await Promise.all([
    env.DB.prepare(`SELECT DISTINCT sku_id FROM stock_movements WHERE tenant_id = ? AND warehouse_id = ? AND sku_id IN (${marks})`)
      .bind(tenantId, wh, ...skuIds).all<{ sku_id: string }>(),
    env.DB.prepare(`SELECT sku_id, available_units FROM product_sourcing_state
        WHERE tenant_id = ? AND provider IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) AND sku_id IN (${marks})`)
      .bind(tenantId, new Date().toISOString(), ...skuIds).all<{ sku_id: string; available_units: number }>(),
  ]);
  const withStock = new Set((moved.results ?? []).map((r) => r.sku_id));
  const fromSupplier = new Map((supplied.results ?? []).map((r) => [r.sku_id, r.available_units]));
  await Promise.all(skuIds.map(async (sku) => {
    try {
      const own = withStock.has(sku) ? Math.max(0, (await stockSvc.getAvailable(env, { tenant_id: tenantId, warehouse_id: wh, sku_id: sku })).available) : 0;
      out[sku] = Math.max(own, fromSupplier.get(sku) ?? 0);
    } catch {
      out[sku] = null;
    }
  }));
  return out;
}
