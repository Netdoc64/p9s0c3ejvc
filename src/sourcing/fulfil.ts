/**
 * Kundenbestellung ↔ Lieferanten-Quelle (Quellenmix Teil 2).
 *
 * Reicht der eigene Bestand für eine Position nicht, darf sie aus der zuletzt
 * gewählten Quelle des Artikels kommen — aber nur, wenn diese Quelle JETZT
 * noch gilt und genug Menge meldet. Es gibt keine geteilte Position (halb
 * Lager, halb Lieferant): eine Position kommt ganz aus einer Herkunft.
 */
import type { Env } from "../env";
import type { OrderDoc } from "../schemas/order";
import { newId } from "../lib/ids";

export interface LineSource {
  provider: string;
  connection: string;
  source_ref: string;
  /** Einkaufspreis je VERKAUFSeinheit (cost je Quell-Einheit × pack). */
  cost_cents: number;
  pack: number;
  delivery_from: string | null;
}

export async function sourceForLine(env: Env, tenantId: string, skuId: string, qty: number): Promise<LineSource | null> {
  const s = await env.DB.prepare(
    `SELECT st.provider, st.connection, st.source_ref, st.cost_cents, st.available_units, st.delivery_from, st.expires_at, ps.pack_factor
       FROM product_sourcing_state st
       JOIN product_sources ps ON ps.tenant_id = st.tenant_id AND ps.sku_id = st.sku_id AND ps.provider = st.provider
        AND ps.connection = st.connection AND ps.source_ref = st.source_ref
      WHERE st.tenant_id = ? AND st.sku_id = ? AND st.provider IS NOT NULL`,
  ).bind(tenantId, skuId).first<{ provider: string; connection: string; source_ref: string; cost_cents: number; available_units: number; delivery_from: string | null; expires_at: string | null; pack_factor: number }>();
  if (!s || s.available_units < qty) return null;
  if (s.expires_at && s.expires_at <= new Date().toISOString()) return null;
  return { provider: s.provider, connection: s.connection, source_ref: s.source_ref, cost_cents: s.cost_cents, pack: s.pack_factor, delivery_from: s.delivery_from };
}

export function lineSource(line: OrderDoc["lines"][number]): LineSource | null {
  const s = (line.resolution as Record<string, unknown>).sourcing;
  return s && typeof s === "object" ? (s as LineSource) : null;
}

/** Je Lieferanten-Position genau eine Anforderung (Wiederholung legt nichts doppelt an). */
export async function createPurchaseRequests(env: Env, doc: OrderDoc): Promise<number> {
  const now = new Date().toISOString();
  const stmts = doc.lines.flatMap((line) => {
    const s = lineSource(line);
    if (!s) return [];
    return [env.DB.prepare(`INSERT INTO supplier_purchase_requests
        (id, tenant_id, order_id, line_no, sku_id, provider, connection, source_ref, qty, source_qty, cost_cents, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT (tenant_id, order_id, line_no) DO NOTHING`)
      .bind(newId("event").replace(/^evt_/, "pr_"), doc.meta.tenant_id, doc.meta.id, line.line_no, line.sku_id, s.provider, s.connection, s.source_ref,
        line.qty, line.qty * s.pack, Math.round(s.cost_cents / s.pack), now, now)];
  });
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** Storno der Kundenbestellung: offene Anforderungen fallen weg, gesendete brauchen einen Menschen. */
export async function cancelPurchaseRequests(env: Env, tenantId: string, orderId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'cancelled', updated_at = ? WHERE tenant_id = ? AND order_id = ? AND status = 'open'").bind(now, tenantId, orderId),
    env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'cancel_requested', updated_at = ?, note = 'Kundenbestellung storniert; beim Lieferanten stornieren' WHERE tenant_id = ? AND order_id = ? AND status = 'sent'").bind(now, tenantId, orderId),
  ]);
}
