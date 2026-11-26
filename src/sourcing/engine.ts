/**
 * Quellenmix: für jeden Verkaufsartikel mit verknüpften Quellen die beste
 * aktuelle Quelle wählen und den Verkaufspreis daraus ableiten.
 *
 * Der Preis landet in der Standard-Preisliste des Tenants als
 * `managed_by = 'sourcing'`. Ein von Hand gepflegter Preis (managed_by NULL)
 * wird NIE überschrieben — der Händler behält das letzte Wort.
 */
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { listOffers, offerKey, type Offer } from "./offers";

export interface Rules {
  strategy: "cheapest" | "priority" | "fastest";
  priority: string[];
  markup_pct: number;
  min_margin_cents: number;
  round_to_cents: number;
}

export const DEFAULT_RULES: Rules = { strategy: "cheapest", priority: [], markup_pct: 30, min_margin_cents: 0, round_to_cents: 1 };

export async function getRules(env: Env, tenantId: string): Promise<Rules> {
  const r = await env.DB.prepare("SELECT strategy, priority, markup_pct, min_margin_cents, round_to_cents FROM sourcing_rules WHERE tenant_id = ?")
    .bind(tenantId).first<{ strategy: Rules["strategy"]; priority: string; markup_pct: number; min_margin_cents: number; round_to_cents: number }>();
  return r ? { ...r, priority: JSON.parse(r.priority) as string[] } : DEFAULT_RULES;
}

/** Verkaufspreis aus Einkaufspreis: Aufschlag, Mindestmarge, dann auf das Raster AUFrunden. */
export function sellPrice(costCents: number, r: Rules): number {
  const withMarkup = Math.ceil(costCents * (1 + r.markup_pct / 100));
  const withMargin = Math.max(withMarkup, costCents + r.min_margin_cents);
  const step = Math.max(1, Math.floor(r.round_to_cents));
  return Math.ceil(withMargin / step) * step;
}

/** Quelle einer Liste wählen; `pack` = Einheiten der Quelle je Verkaufseinheit. */
export function choose(candidates: Array<Offer & { pack: number }>, r: Rules): (Offer & { pack: number }) | null {
  const usable = candidates.filter((o) => Math.floor(o.available_quantity / o.pack) >= 1);
  if (!usable.length) return null;
  const unitCost = (o: Offer & { pack: number }) => o.cost_cents * o.pack;
  const rank = (o: Offer) => {
    const i = r.priority.indexOf(`${o.provider}:${o.connection}`);
    const j = r.priority.indexOf(o.provider);
    return i >= 0 ? i : j >= 0 ? j : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...usable].sort((a, b) => {
    if (r.strategy === "priority" && rank(a) !== rank(b)) return rank(a) - rank(b);
    if (r.strategy === "fastest") {
      const da = a.delivery_from ?? "", db = b.delivery_from ?? "";
      if (da !== db) return da < db ? -1 : 1;
    }
    return unitCost(a) - unitCost(b) || offerKey(a).localeCompare(offerKey(b));
  });
  return sorted[0] ?? null;
}

async function defaultPriceList(env: Env, tenantId: string, currency: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await env.DB.prepare(
    "SELECT id FROM price_lists WHERE tenant_id = ? AND is_default = 1 AND archived_at IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) LIMIT 1",
  ).bind(tenantId, today, today).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId("price_list");
  await env.DB.prepare("INSERT INTO price_lists (id, tenant_id, name, currency, is_default, valid_from, created_at) VALUES (?, ?, 'Standard', ?, 1, ?, ?)")
    .bind(id, tenantId, currency, today, new Date().toISOString()).run();
  return id;
}

export interface RecomputeResult { products: number; priced: number; without_source: number; kept_manual: number }

export async function recompute(env: Env, tenantId: string): Promise<RecomputeResult> {
  const tenant = await env.DB.prepare("SELECT currency FROM tenants WHERE id = ?").bind(tenantId).first<{ currency: string }>();
  if (!tenant) return { products: 0, priced: 0, without_source: 0, kept_manual: 0 };
  const links = await env.DB.prepare("SELECT sku_id, provider, connection, source_ref, pack_factor FROM product_sources WHERE tenant_id = ? ORDER BY sku_id")
    .bind(tenantId).all<{ sku_id: string; provider: string; connection: string; source_ref: string; pack_factor: number }>();
  const bySku = new Map<string, typeof links.results>();
  for (const l of links.results ?? []) bySku.set(l.sku_id, [...(bySku.get(l.sku_id) ?? []), l]);
  const result: RecomputeResult = { products: bySku.size, priced: 0, without_source: 0, kept_manual: 0 };
  if (!bySku.size) return result;

  const rules = await getRules(env, tenantId);
  const offers = new Map((await listOffers(env, tenantId, tenant.currency)).map((o) => [offerKey(o), o]));
  const listId = await defaultPriceList(env, tenantId, tenant.currency);
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  for (const [sku, ls] of bySku) {
    const candidates = ls.flatMap((l) => {
      const o = offers.get(offerKey(l));
      return o ? [{ ...o, pack: l.pack_factor }] : [];
    });
    const best = choose(candidates, rules);
    if (!best) {
      result.without_source++;
      stmts.push(env.DB.prepare(`INSERT INTO product_sourcing_state (tenant_id, sku_id, available_units, reason, computed_at) VALUES (?, ?, 0, 'keine_gueltige_quelle', ?)
        ON CONFLICT (tenant_id, sku_id) DO UPDATE SET provider = NULL, connection = NULL, source_ref = NULL, cost_cents = NULL, available_units = 0, delivery_from = NULL, expires_at = NULL, reason = excluded.reason, computed_at = excluded.computed_at`)
        .bind(tenantId, sku, now));
      continue;
    }
    const cost = best.cost_cents * best.pack;
    const price = sellPrice(cost, rules);
    const units = Math.floor(best.available_quantity / best.pack);
    stmts.push(env.DB.prepare(`INSERT INTO product_sourcing_state (tenant_id, sku_id, provider, connection, source_ref, cost_cents, price_cents, available_units, delivery_from, expires_at, reason, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, sku_id) DO UPDATE SET provider = excluded.provider, connection = excluded.connection, source_ref = excluded.source_ref, cost_cents = excluded.cost_cents,
        price_cents = excluded.price_cents, available_units = excluded.available_units, delivery_from = excluded.delivery_from, expires_at = excluded.expires_at, reason = excluded.reason, computed_at = excluded.computed_at`)
      .bind(tenantId, sku, best.provider, best.connection, best.source_ref, cost, price, units, best.delivery_from, best.expires_at, rules.strategy, now));

    const item = await env.DB.prepare("SELECT id, managed_by FROM price_list_items WHERE price_list_id = ? AND sku_id = ?").bind(listId, sku).first<{ id: string; managed_by: string | null }>();
    if (item && item.managed_by !== "sourcing") { result.kept_manual++; continue; }
    stmts.push(item
      ? env.DB.prepare("UPDATE price_list_items SET unit_price_cents = ? WHERE id = ?").bind(price, item.id)
      : env.DB.prepare("INSERT INTO price_list_items (id, price_list_id, sku_id, unit_price_cents, created_at, managed_by) VALUES (?, ?, ?, ?, ?, 'sourcing')").bind(newId("event"), listId, sku, price, now));
    result.priced++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return result;
}

/** Tenants mit mindestens einer verknüpften Quelle — für den Zeitplan. */
export async function tenantsWithSources(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT s.tenant_id FROM product_sources s JOIN tenants t ON t.id = s.tenant_id WHERE t.status = 'active' AND t.deleted_at IS NULL",
  ).all<{ tenant_id: string }>();
  return (rows.results ?? []).map((r) => r.tenant_id);
}
