import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { stock_movements } from "../db/schema/stock";
import { newId } from "../lib/ids";
import { histogram } from "../observability/metrics";
import { and, eq, isNull } from "drizzle-orm";
import { products } from "../db/schema/products";
import { stock_batches } from "../db/schema/batches";

export interface ReserveParams {
  tenant_id: string;
  warehouse_id: string;
  sku_id: string;
  qty: number;
  ttl_sec?: number;
  idempotency_key?: string;
  customer_id?: string;
}

export interface ReserveResult {
  reservation_id: string;
  expires_at: string;
  idempotent?: boolean;
}

export function key(p: { tenant_id: string; warehouse_id: string; sku_id: string }): string {
  return `${p.tenant_id}/${p.warehouse_id}/${p.sku_id}`;
}

// Workers-Types-Mismatch zwischen lib/Headers und @cloudflare/workers-types Headers
// (getSetCookie). Lokal `any` verwenden statt DurableObjectStub-Typ — nur intern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStub = any;

async function ensureScope(stub: AnyStub, p: { tenant_id: string; warehouse_id: string; sku_id: string }): Promise<void> {
  const res = await stub.fetch("https://stock.local/scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
  await res.arrayBuffer(); // Antwort vollständig lesen, sonst bleibt die DO-Verbindung offen (Storage-Isolation der Tests)
}

async function fetchDo(stub: AnyStub, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await stub.fetch(`https://stock.local${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json };
}

export async function reserve(env: Env, p: ReserveParams): Promise<ReserveResult> {
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, p);
  const ttl = p.ttl_sec ?? 900;
  const t0 = Date.now();
  const r = await fetchDo(stub, "/reserve", { qty: p.qty, ttl_sec: ttl, idempotency_key: p.idempotency_key, customer_id: p.customer_id });
  histogram("stock.reserve.duration_ms", Date.now() - t0, { outcome: r.status === 200 ? "ok" : r.status === 409 ? "conflict" : "error" });
  if (r.status === 409) throw new CodedError("GH-STOCK-001", { detail: r.json });
  if (r.status !== 200) throw new CodedError("GH-STOCK-003", { detail: r.json });
  await flushMovements(env, stub);
  return r.json as ReserveResult;
}

export interface CommitParams { tenant_id: string; warehouse_id: string; sku_id: string; reservation_id: string; idempotency_key?: string; }

export async function commit(env: Env, p: CommitParams): Promise<void> {
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, p);
  const r = await fetchDo(stub, "/commit", { reservation_id: p.reservation_id, idempotency_key: p.idempotency_key });
  if (r.status === 410) throw new CodedError("GH-STOCK-002");
  if (r.status !== 200) throw new CodedError("GH-STOCK-003", { detail: r.json });
  await flushMovements(env, stub);
}

export async function release(env: Env, p: CommitParams): Promise<void> {
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, p);
  await fetchDo(stub, "/release", { reservation_id: p.reservation_id });
  await flushMovements(env, stub);
}

export async function getAvailable(env: Env, p: { tenant_id: string; warehouse_id: string; sku_id: string }): Promise<{ available: number; reserved: number }> {
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, p);
  const res = await stub.fetch("https://stock.local/state");
  const json = (await res.json()) as { available: number; reserved: number };
  return json;
}

export async function adjust(env: Env, p: { tenant_id: string; warehouse_id: string; sku_id: string; qty_delta: number; reason?: string; actor_id?: string; idempotency_key?: string }): Promise<void> {
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, p);
  await fetchDo(stub, "/adjust", { qty_delta: p.qty_delta, reason: p.reason, actor_id: p.actor_id, idempotency_key: p.idempotency_key });
  await flushMovements(env, stub);
}

export async function validateReturnStock(env: Env, tenantId: string, skuId: string, bestBefore?: string) {
  const [product] = await getDb(env.DB).select({ perishable: products.is_perishable }).from(products)
    .where(and(eq(products.tenant_id, tenantId), eq(products.id, skuId), isNull(products.deleted_at))).limit(1);
  if (!product) throw new CodedError("GH-PROD-001");
  if (product.perishable && (!bestBefore || bestBefore < new Date().toISOString().slice(0, 10))) {
    throw new CodedError("GH-RET-002", { reason: "valid_best_before_required" });
  }
}

export async function restockReturn(env: Env, p: {
  tenant_id: string; warehouse_id: string; sku_id: string; qty: number; movement_id: string; best_before?: string;
}): Promise<void> {
  const db = getDb(env.DB);
  const batchId = `rtn_${p.movement_id}`;
  if (p.best_before) {
    const now = new Date().toISOString();
    await db.insert(stock_batches).values({
      id: batchId, tenant_id: p.tenant_id, warehouse_id: p.warehouse_id, sku_id: p.sku_id,
      qty: p.qty, mhd: p.best_before, received_at: now, status: "pending_return", created_at: now,
    }).onConflictDoNothing({ target: stock_batches.id });
  }
  const stub = env.STOCK_DO.get(env.STOCK_DO.idFromName(key(p)));
  await ensureScope(stub, { tenant_id: p.tenant_id, warehouse_id: p.warehouse_id, sku_id: p.sku_id });
  const result = await fetchDo(stub, "/return-stock", { movement_id: p.movement_id, qty: p.qty });
  if (result.status !== 200) throw new CodedError("GH-STOCK-003");
  if (p.best_before) {
    await db.update(stock_batches).set({ status: "active" })
      .where(and(eq(stock_batches.id, batchId), eq(stock_batches.status, "pending_return")));
  }
  await flushMovements(env, stub);
}

/**
 * Liest pending_movements aus dem DO, speichert sie ins D1 stock_movements.
 * Best-Effort: bei DB-Fehler werden movements im DO gehalten (nächster Aufruf retriggers).
 */
async function flushMovements(env: Env, stub: AnyStub): Promise<void> {
  const res = await stub.fetch("https://stock.local/drain-movements", { method: "POST" });
  const { items, scope } = (await res.json()) as { items: Array<{ type: string; qty_delta: number; reservation_id?: string; reason?: string; actor_id?: string; ts: string }>; scope?: { tenant_id: string; warehouse_id: string; sku_id: string } };
  if (!scope || items.length === 0) return;
  const db = getDb(env.DB);
  const rows = items.map((m) => ({
    id: newId("event"),
    tenant_id: scope.tenant_id,
    warehouse_id: scope.warehouse_id,
    sku_id: scope.sku_id,
    type: m.type,
    qty_delta: m.qty_delta,
    reservation_id: m.reservation_id ?? null,
    reason: m.reason ?? null,
    actor_id: m.actor_id ?? null,
    created_at: m.ts,
  }));
  try {
    await db.insert(stock_movements).values(rows);
  } catch (err) {
    // Audit-Fix #S-006: nicht-persistierte Movements landen in einer Backup-KV mit TTL,
    // damit ein Restore-Skript / Backup-Daily sie wieder einspielen kann.
    try {
      const key = `stock:movements:lost:${scope.tenant_id}:${scope.warehouse_id}:${scope.sku_id}:${Date.now()}`;
      await env.KV.put(key, JSON.stringify({ rows, error: err instanceof Error ? err.message : String(err), ts: new Date().toISOString() }), { expirationTtl: 14 * 86_400 });
    } catch {
      // KV auch tot — log only
      console.error(JSON.stringify({ event: "stock.flush_lost", tenant_id: scope.tenant_id, count: rows.length }));
    }
  }
}
