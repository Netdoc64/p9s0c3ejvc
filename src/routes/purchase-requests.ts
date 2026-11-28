/**
 * `/v1/purchase-orders` — Einkauf aus Kundenbestellungen (Quellenmix Teil 2).
 *
 * Anforderungen entstehen automatisch beim Bestätigen einer Kundenbestellung.
 * GESENDET wird nur durch einen Inhaber: eine Einkaufsbestellung kostet Geld
 * und lässt sich beim Lieferanten nicht zurückholen.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { ownerOnly } from "../middleware/tenant-auth";
import { FloridayClient, floridayConfig, type FloridayOffer } from "../integrations/floriday";
import { createPurchase, submitPurchase } from "../integrations/purchase-orders";
import { supplierRecord } from "../integrations/supplier-sync";
import { toCents } from "../sourcing/offers";

export const purchaseRequestsRoutes = new Hono<AppContext>();

interface Req {
  id: string; tenant_id: string; order_id: string; line_no: number; sku_id: string; provider: string; connection: string;
  source_ref: string; qty: number; source_qty: number; cost_cents: number; status: string; supplier_order_id: string | null;
  note: string | null; created_at: string; updated_at: string;
}

purchaseRequestsRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const provider = c.req.query("provider");
  if (status && !["open", "sent", "cancelled", "cancel_requested", "failed"].includes(status)) throw new CodedError("GH-INPUT-001", { field: "status" });
  const rows = await c.env.DB.prepare(`SELECT r.*, p.name AS sku_name, po.status AS supplier_status, po.provider_status
      FROM supplier_purchase_requests r
      LEFT JOIN products p ON p.id = r.sku_id AND p.tenant_id = r.tenant_id
      LEFT JOIN supplier_purchase_orders po ON po.tenant_id = r.tenant_id AND po.id = r.supplier_order_id
      WHERE r.tenant_id = ?1 AND (?2 IS NULL OR r.status = ?2) AND (?3 IS NULL OR r.provider = ?3)
      ORDER BY r.created_at DESC LIMIT 500`).bind(c.var.tenant_id, status ?? null, provider ?? null).all();
  return c.json({ items: rows.results ?? [] });
});

async function requireReq(c: import("hono").Context<AppContext>, id: string): Promise<Req> {
  const r = await c.env.DB.prepare("SELECT * FROM supplier_purchase_requests WHERE id = ? AND tenant_id = ?").bind(id, c.var.tenant_id).first<Req>();
  if (!r) throw new CodedError("GH-SUPPLIER-002");
  return r;
}

const FloridaySend = z.object({
  delivery: z.object({
    latestDeliveryDateTime: z.iso.datetime({ offset: true }),
    gln: z.string().regex(/^\d{13}$/),
    incoterm: z.enum(["DDP", "EXW", "DAP", "FCA", "FOB", "CPT", "CIP", "DPU", "FAS", "CFR", "CIF"]).default("DAP"),
  }).strict(),
  payment_provider: z.enum(["RFH", "VRM", "PLANTION", "FX_SERVICES", "OTHER"]),
  packing_index: z.number().int().nonnegative().default(0),
  reference: z.string().min(1).max(26).optional(),
  /** Ausdrücklich bestätigen, dass zu einem höheren Preis als kalkuliert bestellt wird. */
  accept_price_increase: z.boolean().default(false),
}).strict();

purchaseRequestsRoutes.post("/:id/send", ownerOnly(), async (c) => {
  const r = await requireReq(c, c.req.param("id"));
  if (r.status !== "open") throw new CodedError("GH-SUPPLIER-003", { reason: `status_${r.status}` });
  const now = new Date().toISOString();

  if (r.provider === "file-import") {
    // Datei-Lieferanten haben keine Schnittstelle: übermittelt wird per Bestellliste (CSV).
    const done = await c.env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'sent', note = 'per Bestellliste übermittelt', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open'")
      .bind(now, r.id, r.tenant_id).run();
    if (!done.meta.changes) throw new CodedError("GH-SUPPLIER-003", { reason: "status_changed" });
    return c.json(await requireReq(c, r.id));
  }
  if (r.provider !== "floriday") throw new CodedError("GH-SUPPLIER-001", { reason: "provider_unsupported" });

  const parsed = FloridaySend.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const config = await floridayConfig(c.env, r.tenant_id);
  if (!config) throw new CodedError("GH-SUPPLIER-001", { reason: "connection_missing" });
  const client = new FloridayClient(config);
  const key = { tenantId: r.tenant_id, provider: "floriday", connection: client.connection };
  if (key.connection !== r.connection) throw new CodedError("GH-SUPPLIER-003", { reason: "connection_changed" });
  const offer = await supplierRecord<FloridayOffer>(c.env.DB, key, "offers", r.source_ref);
  if (!offer) throw new CodedError("GH-SUPPLIER-002");
  // Teurer als kalkuliert? Dann nur mit ausdrücklicher Bestätigung — sonst schmilzt die Marge unbemerkt.
  const offerCents = toCents(offer.pricePerPiece.value);
  if (offerCents > r.cost_cents && !parsed.data.accept_price_increase) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "price_increased", calculated_cents: r.cost_cents, offer_cents: offerCents });
  }

  // Dieselbe Kennung bei JEDEM Versuch, auch bei zwei gleichzeitigen: die Kennung wird atomar
  // beansprucht und danach nur der gespeicherte Wert benutzt. createPurchase ist je Kennung
  // idempotent, submitPurchase sendet je Kennung höchstens einmal — so entsteht keine zweite Bestellung.
  await c.env.DB.prepare("UPDATE supplier_purchase_requests SET supplier_order_id = COALESCE(supplier_order_id, ?), updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open'")
    .bind(crypto.randomUUID(), now, r.id, r.tenant_id).run();
  const claimed = await requireReq(c, r.id);
  if (claimed.status !== "open" || !claimed.supplier_order_id) throw new CodedError("GH-SUPPLIER-003", { reason: `status_${claimed.status}` });
  const orderId = claimed.supplier_order_id;
  try {
    await createPurchase(c.env.DB, key, {
      id: orderId, offer_id: r.source_ref, number_of_pieces: r.source_qty, packing_index: parsed.data.packing_index,
      expected_price_per_piece: offer.pricePerPiece,
      delivery: { latestDeliveryDateTime: parsed.data.delivery.latestDeliveryDateTime, location: { gln: parsed.data.delivery.gln }, incoterm: parsed.data.delivery.incoterm },
      payment_provider: parsed.data.payment_provider,
      reference: parsed.data.reference ?? r.order_id.slice(-26),
    });
    const po = await submitPurchase(c.env.DB, key, client, orderId);
    // Wurde inzwischen storniert, bleibt der Storno sichtbar: dann ist es ein Storno beim Lieferanten.
    await c.env.DB.prepare(`UPDATE supplier_purchase_requests SET status = CASE WHEN status = 'cancelled' THEN 'cancel_requested' ELSE 'sent' END,
        note = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('open', 'cancelled')`)
      .bind(`Floriday: ${po.status}`, new Date().toISOString(), r.id, r.tenant_id).run();
  } catch (err) {
    const reason = err instanceof CodedError ? `${err.code} ${String((err.detail as { reason?: string } | undefined)?.reason ?? "")}`.trim() : "Senden fehlgeschlagen";
    await c.env.DB.prepare("UPDATE supplier_purchase_requests SET note = ?, updated_at = ? WHERE id = ? AND tenant_id = ?").bind(reason, new Date().toISOString(), r.id, r.tenant_id).run();
    throw err;
  }
  return c.json(await requireReq(c, r.id));
});

purchaseRequestsRoutes.post("/:id/cancel", ownerOnly(), async (c) => {
  const r = await requireReq(c, c.req.param("id"));
  if (r.status === "open") {
    await c.env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'open'").bind(new Date().toISOString(), r.id, r.tenant_id).run();
  } else if (r.status === "cancel_requested") {
    // Der Mensch bestätigt, dass beim Lieferanten storniert wurde.
    await c.env.DB.prepare("UPDATE supplier_purchase_requests SET status = 'cancelled', note = 'beim Lieferanten storniert (bestätigt)', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'cancel_requested'")
      .bind(new Date().toISOString(), r.id, r.tenant_id).run();
  } else {
    throw new CodedError("GH-SUPPLIER-003", { reason: `status_${r.status}` });
  }
  return c.json(await requireReq(c, r.id));
});

/** Bestellliste für einen Datei-Lieferanten: offene Anforderungen je Artikel zusammengefasst (CSV). */
purchaseRequestsRoutes.get("/export", async (c) => {
  const connection = c.req.query("connection");
  if (!connection || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connection) || connection.length > 64) throw new CodedError("GH-INPUT-001", { field: "connection" });
  const rows = await c.env.DB.prepare(`SELECT source_ref, SUM(source_qty) AS qty, COUNT(*) AS positions FROM supplier_purchase_requests
      WHERE tenant_id = ? AND provider = 'file-import' AND connection = ? AND status = 'open' GROUP BY source_ref ORDER BY source_ref`)
    .bind(c.var.tenant_id, connection).all<{ source_ref: string; qty: number; positions: number }>();
  // Tabellenprogramme führen Zellen mit = + - @ als Formel aus: mit ' entschärfen. Dann quoten, wo nötig.
  const esc = (raw: string) => {
    const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const csv = ["sku;menge;positionen", ...(rows.results ?? []).map((r) => `${esc(r.source_ref)};${r.qty};${r.positions}`)].join("\n") + "\n";
  return c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="bestellliste-${connection}.csv"` });
});
