import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { feed_runs, tenant_pricing_feeds } from "../db/schema/feeds";
import { price_list_items, price_lists } from "../db/schema/pricing";
import { newId } from "../lib/ids";

export interface FeedRow {
  sku_code: string;
  unit_price_cents: number;
}

export interface FeedAdapter {
  id: string;
  fetchAndParse(url: string): Promise<FeedRow[]>;
}

/**
 * CSV-Generic-Adapter: erwartet Header `sku_code,unit_price_cents`.
 * Adaptiert von Aalsmeer-/RBC-spezifischen Formaten in einer Plan-Revision.
 */
export const csvGenericAdapter: FeedAdapter = {
  id: "csv-generic",
  async fetchAndParse(url) {
    const res = await fetch(url, { headers: { Accept: "text/csv" } });
    if (!res.ok) throw new Error(`feed http ${res.status}`);
    const text = await res.text();
    const rows: FeedRow[] = [];
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return rows;
    const header = (lines[0] ?? "").toLowerCase().split(",").map((s) => s.trim());
    const skuIdx = header.indexOf("sku_code");
    const priceIdx = header.indexOf("unit_price_cents");
    if (skuIdx < 0 || priceIdx < 0) throw new Error("missing required CSV columns");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.trim()) continue;
      const cells = line.split(",");
      const sku = (cells[skuIdx] ?? "").trim();
      const priceStr = (cells[priceIdx] ?? "").trim();
      const price = Number(priceStr);
      if (!sku || !Number.isFinite(price)) continue;
      rows.push({ sku_code: sku, unit_price_cents: Math.round(price) });
    }
    return rows;
  },
};

const ADAPTERS: Record<string, FeedAdapter> = {
  "csv-generic": csvGenericAdapter,
  // Plan-Revision: aalsmeer, rbc
};

export interface RunFeedResult {
  feed_id: string;
  status: "success" | "blocked_drift" | "failed";
  rows_imported: number;
  rows_skipped: number;
  drift_pct: number;
  new_price_list_id?: string;
  error_code?: string;
  error_detail?: string;
}

export async function runFeed(env: Env, feed_id: string): Promise<RunFeedResult> {
  const db = getDb(env.DB);
  const feed = (await db.select().from(tenant_pricing_feeds).where(eq(tenant_pricing_feeds.id, feed_id)).limit(1))[0];
  if (!feed) throw new Error(`feed ${feed_id} not found`);
  const adapter = ADAPTERS[feed.adapter];
  const run_id = newId("event");
  const startedAt = new Date().toISOString();
  await db.insert(feed_runs).values({ id: run_id, feed_id, tenant_id: feed.tenant_id, status: "running", started_at: startedAt, drift_blocked: 0 });

  try {
    if (!adapter) throw new Error(`unknown adapter: ${feed.adapter}`);
    const rows = await adapter.fetchAndParse(feed.url);
    if (rows.length === 0) throw new Error("no rows in feed");

    // Drift-Detection vs. aktuelle Default-Liste
    const currentList = (await db.select().from(price_lists).where(eq(price_lists.tenant_id, feed.tenant_id)).limit(1))[0];
    let driftPct = 0;
    let driftBlocked = false;
    if (currentList) {
      const currentItems = await db.select().from(price_list_items).where(eq(price_list_items.price_list_id, currentList.id));
      const oldMap = new Map<string, number>();
      for (const it of currentItems) oldMap.set(it.sku_id, it.unit_price_cents);
      // SKU-codes → sku_id mapping erfordert Products-Lookup. Vereinfacht:
      const { products } = await import("../db/schema/products");
      const skuMap = new Map<string, string>();
      const allProducts = await db.select({ id: products.id, sku_code: products.sku_code }).from(products).where(eq(products.tenant_id, feed.tenant_id));
      for (const p of allProducts) skuMap.set(p.sku_code, p.id);
      let driftHits = 0;
      let comparable = 0;
      for (const r of rows) {
        const sku_id = skuMap.get(r.sku_code);
        if (!sku_id) continue;
        const oldPrice = oldMap.get(sku_id);
        if (oldPrice === undefined || oldPrice === 0) continue;
        comparable += 1;
        const change = Math.abs(r.unit_price_cents - oldPrice) / oldPrice * 100;
        if (change > feed.drift_threshold_pct) driftHits += 1;
      }
      driftPct = comparable > 0 ? (driftHits / comparable) * 100 : 0;
      if (driftPct > feed.drift_skus_pct) driftBlocked = true;
    }

    if (driftBlocked) {
      const endedAt = new Date().toISOString();
      await db.update(feed_runs).set({ status: "blocked_drift", drift_pct: driftPct, drift_blocked: 1, rows_imported: 0, rows_skipped: rows.length, ended_at: endedAt, error_code: "GH-FEED-002", error_detail: `drift ${driftPct.toFixed(1)}% > ${feed.drift_skus_pct}% threshold` }).where(eq(feed_runs.id, run_id));
      return { feed_id, status: "blocked_drift", rows_imported: 0, rows_skipped: rows.length, drift_pct: driftPct, error_code: "GH-FEED-002", error_detail: "drift exceeded" };
    }

    // Neue price_list-Version anlegen
    const new_list_id = newId("price_list");
    const now = new Date().toISOString();
    const currency = currentList?.currency ?? "EUR";
    await db.insert(price_lists).values({ id: new_list_id, tenant_id: feed.tenant_id, name: `feed:${feed.adapter}:${now.slice(0, 10)}`, currency, is_default: 1, valid_from: now, valid_to: null, created_at: now });
    // Alte Default deaktivieren
    if (currentList) {
      await db.update(price_lists).set({ is_default: 0 }).where(eq(price_lists.id, currentList.id));
    }
    // Items
    const { products } = await import("../db/schema/products");
    const all = await db.select({ id: products.id, sku_code: products.sku_code }).from(products).where(eq(products.tenant_id, feed.tenant_id));
    const skuMap = new Map<string, string>(all.map((p) => [p.sku_code, p.id]));
    let imported = 0;
    let skipped = 0;
    const itemRows: typeof price_list_items.$inferInsert[] = [];
    for (const r of rows) {
      const sku_id = skuMap.get(r.sku_code);
      if (!sku_id) { skipped += 1; continue; }
      itemRows.push({ id: newId("event"), price_list_id: new_list_id, sku_id, unit_price_cents: r.unit_price_cents, created_at: now });
      imported += 1;
    }
    if (itemRows.length > 0) await db.insert(price_list_items).values(itemRows);

    const endedAt = new Date().toISOString();
    await db.update(feed_runs).set({ status: "success", rows_imported: imported, rows_skipped: skipped, drift_pct: driftPct, new_price_list_id: new_list_id, ended_at: endedAt }).where(eq(feed_runs.id, run_id));
    await db.update(tenant_pricing_feeds).set({ last_run_at: endedAt }).where(eq(tenant_pricing_feeds.id, feed_id));
    return { feed_id, status: "success", rows_imported: imported, rows_skipped: skipped, drift_pct: driftPct, new_price_list_id: new_list_id };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const detail = err instanceof Error ? err.message : String(err);
    await db.update(feed_runs).set({ status: "failed", ended_at: endedAt, error_code: "GH-FEED-001", error_detail: detail }).where(eq(feed_runs.id, run_id));
    return { feed_id, status: "failed", rows_imported: 0, rows_skipped: 0, drift_pct: 0, error_code: "GH-FEED-001", error_detail: detail };
  }
}
