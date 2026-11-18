import { CodedError } from "../errors/catalog";
import { type FloridayClient, type FloridayOffer, type PurchaseInput } from "./floriday";
import { supplierRecord, type SupplierConnection } from "./supplier-sync";

type PurchaseOrder = {
  id: string;
  offer_id: string;
  request: string;
  status: "draft" | "submitting" | "unknown" | "submitted" | "rejected";
  provider_status: string | null;
  provider_sequence: number | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export function publicOrder({ request, ...order }: PurchaseOrder) {
  const { input } = JSON.parse(request) as { input: PurchaseInput };
  return { ...order, input };
}

export async function findPurchase(db: D1Database, key: SupplierConnection, id: string) {
  return db.prepare(`
    SELECT id, offer_id, request, status, provider_status, provider_sequence, last_checked_at, created_at, updated_at
    FROM supplier_purchase_orders WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ?
  `).bind(key.tenantId, key.provider, key.connection, id).first<PurchaseOrder>();
}

export async function requirePurchase(db: D1Database, key: SupplierConnection, id: string) {
  const order = await findPurchase(db, key, id);
  if (!order) throw new CodedError("GH-SUPPLIER-002");
  return order;
}

type CatalogItem = { packingConfigurations?: FloridayOffer["packingConfigurations"] };

async function makeRequest(db: D1Database, key: SupplierConnection, input: PurchaseInput) {
  const offer = await supplierRecord<FloridayOffer>(db, key, "offers", input.offer_id);
  if (!offer) throw new CodedError("GH-SUPPLIER-002");
  const now = Date.now();
  const delivery = Date.parse(input.delivery.latestDeliveryDateTime);
  if (Date.parse(offer.orderPeriod.startDateTime) > now || Date.parse(offer.orderPeriod.endDateTime) <= now ||
      delivery <= now || (offer.isLimited && input.number_of_pieces > offer.numberOfPieces) ||
      (offer.deliveryPeriod && (delivery < Date.parse(offer.deliveryPeriod.startDateTime) ||
        delivery > Date.parse(offer.deliveryPeriod.endDateTime)))) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "offer_or_delivery_unavailable" });
  }

  const item = offer.type === "CATALOG" ? await supplierRecord<CatalogItem>(db, key, "catalog", offer.tradeItemId) : null;
  const selected = (offer.packingConfigurations?.length ? offer.packingConfigurations : item?.packingConfigurations)?.[input.packing_index];
  if (!selected || selected.layersPerLoadCarrier < 1 || selected.packagesPerLayer < 1) {
    throw new CodedError("GH-INPUT-001", { field: "packing_index" });
  }
  const { isPrimary: _isPrimary, ...packingConfiguration } = selected;
  const packages = selected.piecesPerPackage;
  const layers = packages * selected.packagesPerLayer;
  const carriers = layers * selected.layersPerLoadCarrier;
  const ratios = { PACKAGE: packages, LAYER: layers, LOAD_CARRIER: carriers };
  const unitSize = {
    ...ratios, PIECE: 1, SUPPLY_LINE: offer.numberOfPieces,
  }[offer.salesUnit];
  if (unitSize <= 0 || input.number_of_pieces % unitSize !== 0 ||
      (offer.salesUnit === "SUPPLY_LINE" && input.number_of_pieces !== unitSize)) {
    throw new CodedError("GH-INPUT-001", { field: "number_of_pieces" });
  }

  const applicable = offer.volumePrices.filter((tier) => input.number_of_pieces >= tier.minimumQuantity * ratios[tier.unit]);
  const effectivePrice = Math.min(offer.pricePerPiece.value, ...applicable.map((tier) => tier.pricePerPiece));
  const expected = input.expected_price_per_piece;
  const surcharge = selected.additionalPricePerPiece;
  const expectedSurcharge = input.expected_packaging_price_per_piece;
  if ((surcharge?.value ?? 0) !== (expectedSurcharge?.value ?? 0) ||
      (expectedSurcharge && expectedSurcharge.currency !== (surcharge?.currency ?? expected.currency))) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "packaging_price_changed" });
  }
  if (expected.currency !== offer.pricePerPiece.currency || expected.value !== effectivePrice) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "price_changed" });
  }
  return {
    salesOrderId: input.id, supplyLineId: input.offer_id, supplierOrganizationId: offer.supplierOrganizationId,
    numberOfPieces: input.number_of_pieces, pricePerPiece: expected, packingConfiguration,
    customerOrderReference: input.reference, delivery: input.delivery, paymentProvider: input.payment_provider,
  };
}

export async function createPurchase(db: D1Database, key: SupplierConnection, input: PurchaseInput) {
  const existing = await findPurchase(db, key, input.id);
  if (!existing) {
    const payload = await makeRequest(db, key, input);
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR IGNORE INTO supplier_purchase_orders
        (tenant_id, id, provider, connection, offer_id, request, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).bind(key.tenantId, input.id, key.provider, key.connection, input.offer_id,
      JSON.stringify({ input, payload }), now, now).run();
  }
  const order = await requirePurchase(db, key, input.id);
  if (JSON.stringify(publicOrder(order).input) !== JSON.stringify(input)) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "order_id_already_used" });
  }
  return order;
}

export async function submitPurchase(db: D1Database, key: SupplierConnection, client: FloridayClient, id: string) {
  if (!client.orderingEnabled) throw new CodedError("GH-SUPPLIER-001", { reason: "ordering_disabled" });
  const order = await requirePurchase(db, key, id);
  if (order.status !== "draft") return order;

  const { input, payload } = JSON.parse(order.request) as { input: PurchaseInput; payload: unknown };
  if (JSON.stringify(await makeRequest(db, key, input)) !== JSON.stringify(payload)) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "offer_changed" });
  }
  await client.prepareOrderSubmission();
  const scope = [key.tenantId, key.provider, key.connection, id];
  const lock = await db.prepare(`
    UPDATE supplier_purchase_orders SET status = 'submitting', updated_at = ?
    WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ? AND status = 'draft'
  `).bind(new Date().toISOString(), ...scope).run();
  if (lock.meta.changes === 1) {
    let status = "submitted";
    try {
      await client.submitOrder(JSON.stringify(payload));
    } catch {
      // A lost response can follow a successful order. Lookup by the same UUID;
      // never issue a second POST on the basis of a timeout or an HTTP error.
      status = "unknown";
    }
    await db.prepare(`
      UPDATE supplier_purchase_orders SET status = ?, updated_at = ?
      WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ? AND status = 'submitting'
    `).bind(status, new Date().toISOString(), ...scope).run();
  }
  return requirePurchase(db, key, id);
}

export async function reconcilePurchase(db: D1Database, key: SupplierConnection, client: FloridayClient, id: string) {
  const order = await requirePurchase(db, key, id);
  if (!client.orderingEnabled || order.status === "draft") return order;
  const checkedAt = new Date().toISOString();
  const scope = [key.tenantId, key.provider, key.connection, id];
  await db.prepare(`
    UPDATE supplier_purchase_orders SET last_checked_at = ?
    WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ?
      AND (last_checked_at IS NULL OR last_checked_at < ?)
  `).bind(checkedAt, ...scope, checkedAt).run();
  const remote = await client.getOrder(id);
  if (remote) {
    const status = ["REJECTED", "CANCELLED", "EXPIRED", "UNFULFILLABLE"].includes(remote.status) ? "rejected" : "submitted";
    await db.prepare(`
      UPDATE supplier_purchase_orders SET status = ?, provider_status = ?, provider_sequence = ?, updated_at = ?
      WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ?
        AND (provider_sequence IS NULL OR provider_sequence < ?)
    `).bind(status, remote.status, remote.sequenceNumber, new Date().toISOString(),
      ...scope, remote.sequenceNumber).run();
  } else if (order.status === "submitting" && Date.now() - Date.parse(order.updated_at) > 60_000) {
    await db.prepare(`
      UPDATE supplier_purchase_orders SET status = 'unknown', updated_at = ?
      WHERE tenant_id = ? AND provider = ? AND connection = ? AND id = ? AND status = 'submitting'
    `).bind(new Date().toISOString(), ...scope).run();
  }
  return requirePurchase(db, key, id);
}


export async function reconcilePendingPurchases(db: D1Database, key: SupplierConnection, client: FloridayClient) {
  if (!client.orderingEnabled) return;
  const pending = await db.prepare(`
    SELECT id FROM supplier_purchase_orders WHERE tenant_id = ? AND provider = ? AND connection = ?
      AND status IN ('submitting', 'unknown', 'submitted')
      AND (provider_status IS NULL OR provider_status IN ('PENDING', 'ACCEPTED'))
    ORDER BY last_checked_at, created_at, id LIMIT 5
  `).bind(key.tenantId, key.provider, key.connection).all<{ id: string }>();
  for (const { id } of pending.results) {
    try {
      await reconcilePurchase(db, key, client, id);
    } catch {
      console.error(JSON.stringify({ event: "supplier.reconcile_failed", provider: key.provider, tenant_id: key.tenantId, id }));
    }
  }
}
