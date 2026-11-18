/**
 * FEFO (First-Expire-First-Out) Advisory-Check + Allocation-Plan.
 *
 * v1 Pragma: Stock-DO bleibt Single-Counter. Der FEFO-Check läuft VOR der
 * DO-Reservierung und stellt sicher, dass:
 *  - Mindestens eine aktive Batch mit ausreichender Restlaufzeit existiert
 *  - Die Summe der eligibles Batches >= requested qty ist
 *
 * Plan-Revision: per-Batch-Allocation-Tracking (qty_remaining-Spalte) für
 * korrekte Decrement bei Commit. Aktuell: advisory-only, DO ist Source-of-Truth.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { stock_batches } from "../db/schema/batches";
import { tenants } from "../db/schema/tenants";
import { products } from "../db/schema/products";
import { CodedError } from "../errors/catalog";

export interface FefoCheckParams {
  tenant_id: string;
  warehouse_id: string;
  sku_id: string;
  qty: number;
  on_date?: string;
}

export interface FefoAllocation {
  batch_id: string;
  mhd: string | null;
  qty: number;
}

export interface FefoCheckResult {
  ok: boolean;
  total_eligible: number;
  allocations: FefoAllocation[];
  /** Wenn `ok=false`: Differenz zwischen eligible und requested. */
  shortfall?: number;
  /** Wenn das Produkt nicht perishable ist, läuft der Check ohne Filterung. */
  product_is_perishable: boolean;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86_400_000);
}

export async function fefoCheck(db: DB, params: FefoCheckParams): Promise<FefoCheckResult> {
  const onDate = params.on_date ? new Date(params.on_date) : new Date();

  // Tenant min_shelf_life_days + Product perishable-Flag laden
  const trow = (await db.select({ min: tenants.min_shelf_life_days }).from(tenants).where(eq(tenants.id, params.tenant_id)).limit(1))[0];
  const minShelfDays = trow?.min ?? 3;
  const prow = (await db.select({ perishable: products.is_perishable }).from(products).where(and(eq(products.id, params.sku_id), eq(products.tenant_id, params.tenant_id))).limit(1))[0];
  const isPerishable = (prow?.perishable ?? 0) === 1;

  // Aktive Batches sortiert nach mhd ASC (FEFO)
  const batches = await db.select().from(stock_batches).where(and(
    eq(stock_batches.tenant_id, params.tenant_id),
    eq(stock_batches.warehouse_id, params.warehouse_id),
    eq(stock_batches.sku_id, params.sku_id),
    eq(stock_batches.status, "active"),
  )).orderBy(asc(stock_batches.mhd));

  // Filter: bei perishable + mhd-set, brauchen min_shelf_life_days Restlaufzeit
  const eligible = batches.filter((b) => {
    if (!isPerishable || !b.mhd) return true;
    const remainingDays = daysBetween(onDate, new Date(b.mhd));
    return remainingDays >= minShelfDays;
  });

  // Allocation-Plan
  const allocations: FefoAllocation[] = [];
  let totalEligible = 0;
  let remaining = params.qty;
  for (const b of eligible) {
    totalEligible += b.qty;
    if (remaining <= 0) continue;
    const take = Math.min(remaining, b.qty);
    if (take > 0) {
      allocations.push({ batch_id: b.id, mhd: b.mhd, qty: take });
      remaining -= take;
    }
  }

  if (totalEligible >= params.qty) {
    return { ok: true, total_eligible: totalEligible, allocations, product_is_perishable: isPerishable };
  }
  return {
    ok: false,
    total_eligible: totalEligible,
    allocations,
    shortfall: params.qty - totalEligible,
    product_is_perishable: isPerishable,
  };
}

/** Wirft `GH-FEFO-001` wenn Check nicht ok ist. */
export async function assertFefoOk(db: DB, params: FefoCheckParams): Promise<FefoCheckResult> {
  const r = await fefoCheck(db, params);
  if (!r.ok) {
    throw new CodedError("GH-FEFO-001", {
      sku_id: params.sku_id,
      requested: params.qty,
      total_eligible: r.total_eligible,
      shortfall: r.shortfall,
    });
  }
  return r;
}
