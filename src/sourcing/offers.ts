/**
 * Alle Lieferanten-Angebote eines Tenants in EINER Form, egal woher.
 *
 * Quellen heute: Floriday (synchronisierte Angebote) und Lieferanten-Dateien
 * (Importstände). Ausgeblendet wird, was abgelaufen ist, nichts mehr verfügbar
 * hat, in einer fremden Währung kostet oder aus einem ausgeschalteten Modul
 * stammt. Preise werden auf ganze Cent je Einheit AUFgerundet — lieber einen
 * Cent zu hoch kalkuliert als ein Verlust je Stück.
 */
import type { Env } from "../env";

export interface Offer {
  provider: string;
  connection: string;
  /** Stabile Kennung innerhalb der Quelle (Floriday: supplyLineId, Datei: SKU). */
  source_ref: string;
  sku: string;
  name: string;
  unit: string;
  cost_cents: number;
  currency: string;
  available_quantity: number;
  minimum_quantity: number;
  delivery_from: string | null;
  expires_at: string | null;
}

/** Höchstens so viele Rohdatensätze je Abruf; Floriday-Konten können groß sein. */
const SCAN_LIMIT = 5000;

export function toCents(value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.ceil(Math.round(n * 1_000_000) / 10_000);
}

async function disabledProviders(env: Env, tenantId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT module_id FROM tenant_modules WHERE tenant_id = ? AND (enabled = 0 OR available = 0)")
    .bind(tenantId).all<{ module_id: string }>();
  return new Set((rows.results ?? []).map((r) => r.module_id));
}

export async function listOffers(env: Env, tenantId: string, currency: string): Promise<Offer[]> {
  const off = await disabledProviders(env, tenantId);
  const now = new Date().toISOString();
  const out: Offer[] = [];

  if (!off.has("file-import")) {
    const files = await env.DB.prepare(
      "SELECT connection, data FROM supplier_records WHERE tenant_id = ? AND provider = 'file-import' AND stream = 'offers' AND external_id = 'snapshot' AND deleted = 0",
    ).bind(tenantId).all<{ connection: string; data: string }>();
    for (const row of files.results ?? []) {
      const snap = JSON.parse(row.data) as { expires_at: string; items: Array<{ sku: string; name: string; unit: string; unit_price: string; currency: string; available_quantity: number; minimum_quantity: number }> };
      if (!(snap.expires_at > now)) continue;
      for (const it of snap.items) {
        const cost = toCents(it.unit_price);
        if (it.currency !== currency || !Number.isFinite(cost) || it.available_quantity <= 0) continue;
        out.push({
          provider: "file-import", connection: row.connection, source_ref: it.sku, sku: it.sku, name: it.name, unit: it.unit,
          cost_cents: cost, currency: it.currency, available_quantity: it.available_quantity, minimum_quantity: it.minimum_quantity,
          delivery_from: null, expires_at: snap.expires_at,
        });
      }
    }
  }

  if (!off.has("floriday")) {
    const rows = await env.DB.prepare(`
      SELECT r.connection, r.external_id, r.data, a.data AS article FROM supplier_records r
      LEFT JOIN supplier_records a ON a.tenant_id = r.tenant_id AND a.provider = r.provider AND a.connection = r.connection
        AND a.stream = 'catalog' AND a.deleted = 0 AND a.external_id = json_extract(r.data, '$.tradeItemId')
      WHERE r.tenant_id = ? AND r.provider = 'floriday' AND r.stream = 'offers' AND r.deleted = 0
        AND json_extract(r.data, '$.status') = 'AVAILABLE'
        AND julianday(json_extract(r.data, '$.orderPeriod.endDateTime')) > julianday('now')
      LIMIT ?`).bind(tenantId, SCAN_LIMIT).all<{ connection: string; external_id: string; data: string; article: string | null }>();
    for (const row of rows.results ?? []) {
      const d = JSON.parse(row.data) as { pricePerPiece: { currency: string; value: number }; numberOfPieces: number; tradeItemId: string; orderPeriod: { endDateTime: string }; deliveryPeriod?: { startDateTime: string } | null; packingConfigurations?: Array<{ piecesPerPackage: number; isPrimary?: boolean }> | null };
      const art = row.article ? JSON.parse(row.article) as { name?: string | null; code?: string | null } : null;
      const cost = toCents(d.pricePerPiece.value);
      if (d.pricePerPiece.currency !== currency || !Number.isFinite(cost) || d.numberOfPieces <= 0) continue;
      const pack = d.packingConfigurations?.find((p) => p.isPrimary) ?? d.packingConfigurations?.[0];
      out.push({
        provider: "floriday", connection: row.connection, source_ref: row.external_id, sku: art?.code ?? d.tradeItemId,
        name: art?.name ?? "Floriday-Artikel", unit: "piece", cost_cents: cost, currency, available_quantity: d.numberOfPieces,
        minimum_quantity: pack?.piecesPerPackage ?? 1, delivery_from: d.deliveryPeriod?.startDateTime ?? null, expires_at: d.orderPeriod.endDateTime,
      });
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name) || a.cost_cents - b.cost_cents);
}

export const offerKey = (o: { provider: string; connection: string; source_ref: string }) => `${o.provider}|${o.connection}|${o.source_ref}`;
