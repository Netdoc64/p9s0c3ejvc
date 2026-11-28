/**
 * Kunden-API unter `/v1/customer` — für die mobile App (Kunden-JWT aus
 * `/v1/oauth/token`). Tenant-Zugangsdaten (API-Key + HMAC) bleiben serverseitig
 * und kommen hier nie vor.
 *
 * Tenant und Kunde stammen IMMER aus der Sitzung (customerAuth), nie aus dem
 * Request. Bestellungen laufen über services/customer-orders.ts — denselben
 * Code wie der MCP-Endpunkt — und verlassen den Server nur als Kundenansicht.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import * as productsRepo from "../repos/products";
import * as customersRepo from "../repos/customers";
import * as ordersRepo from "../repos/orders";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { product_images } from "../db/schema/products";
import { productImagePath } from "./product-images";
import { tenants } from "../db/schema/tenants";
import { parseCursor, signCursor } from "../lib/http";
import { resolvePricingFromDb } from "../services/pricing-resolver";
import { newId } from "../lib/ids";
import { isSettled, readOperation, runOperation, settlePending, type CheckoutOperation } from "../services/customer-order-operations";
import * as orders from "../services/customer-orders";
import { availableQuantities } from "../sourcing/availability";

export const customerApiRoutes = new Hono<AppContext>();

function session(c: Context<AppContext>, need: "read" | "write"): orders.CustomerSession {
  const tenant_id = c.var.tenant_id;
  const customer_id = c.var.customer_id;
  if (!tenant_id || !customer_id) throw new CodedError("GH-AUTH-001");
  const scopes = new Set(c.var.scopes ?? []);
  if (scopes.has("customer_self")) { scopes.add("customer_self.read"); scopes.add("customer_self.write"); }
  if (!scopes.has(`customer_self.${need}`)) throw new CodedError("GH-AUTH-004", { required: `customer_self.${need}` });
  return { tenant_id, customer_id };
}

type Product = NonNullable<Awaited<ReturnType<typeof productsRepo.findById>>>;

/** Jüngstes Bild je Artikel (mandantengetrennt) als öffentliche URL. */
async function imageUrls(c: Context<AppContext>, tenant_id: string, ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await getDb(c.env.DB)
    .select({ id: product_images.id, sku_id: product_images.sku_id, created_at: product_images.created_at })
    .from(product_images)
    .where(and(eq(product_images.tenant_id, tenant_id), inArray(product_images.sku_id, ids)))
    .orderBy(desc(product_images.created_at));
  const origin = new URL(c.req.url).origin;
  const out: Record<string, string> = {};
  for (const r of rows) if (!out[r.sku_id]) out[r.sku_id] = `${origin}${productImagePath(r.id)}`;
  return out;
}

function productView(p: Product, images: Record<string, string> = {}, available: Record<string, number | null> = {}) {
  const json = (s: string, fallback: unknown) => { try { return JSON.parse(s) as unknown; } catch { return fallback; } };
  return {
    id: p.id,
    sku_code: p.sku_code,
    name: p.name,
    description: p.description ?? null,
    min_order_qty: p.min_order_qty,
    packaging_units: json(p.packaging_units, []),
    attributes: json(p.attributes, {}),
    image_url: images[p.id] ?? null,
    // Bestellbare Menge in Verkaufseinheiten; null = gerade nicht ermittelbar.
    available_quantity: available[p.id] ?? null,
  };
}

// ── Konto ────────────────────────────────────────────────────────────────
customerApiRoutes.get("/me", async (c) => {
  const s = session(c, "read");
  const db = getDb(c.env.DB);
  const cust = await customersRepo.requireById(db, s.tenant_id, s.customer_id);
  const tenant = (await db.select({ name: tenants.name, country: tenants.country, currency: tenants.currency })
    .from(tenants).where(and(eq(tenants.id, s.tenant_id), isNull(tenants.deleted_at))).limit(1))[0];
  return c.json({
    customer: { id: cust.id, name: cust.name, email: cust.email ?? null, country: cust.country, vat_id: cust.vat_id ?? null },
    merchant: { name: tenant?.name ?? null, country: tenant?.country ?? null, currency: tenant?.currency ?? null },
  });
});

// ── Katalog ──────────────────────────────────────────────────────────────
const ListQuery = z.object({
  q: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(500).optional(),
});

customerApiRoutes.get("/products", async (c) => {
  const s = session(c, "read");
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const db = getDb(c.env.DB);
  const limit = parsed.data.limit ?? 20;
  if (parsed.data.q) {
    const items = (await productsRepo.search(db, s.tenant_id, parsed.data.q, limit)).filter((p) => p.status === "active");
    const imgs = await imageUrls(c, s.tenant_id, items.map((p) => p.id));
    const avail = await availableQuantities(c.env, s.tenant_id, items.map((p) => p.id));
    return c.json({ items: items.map((p) => productView(p, imgs, avail)), next_cursor: null });
  }
  const cursor = await parseCursor(c.env, parsed.data.cursor);
  const rows = await productsRepo.list(db, s.tenant_id, { cursor, limit });
  const last = rows[rows.length - 1];
  const next_cursor = rows.length === limit && last ? await signCursor(c.env, { created_at: last.created_at, id: last.id }) : null;
  const active = rows.filter((p) => p.status === "active");
  const imgs = await imageUrls(c, s.tenant_id, active.map((p) => p.id));
  const avail = await availableQuantities(c.env, s.tenant_id, active.map((p) => p.id));
  return c.json({ items: active.map((p) => productView(p, imgs, avail)), next_cursor });
});

customerApiRoutes.get("/products/:id", async (c) => {
  const s = session(c, "read");
  const p = await productsRepo.findById(getDb(c.env.DB), s.tenant_id, c.req.param("id"));
  if (!p || p.status !== "active") throw new CodedError("GH-PROD-001");
  return c.json(productView(p, await imageUrls(c, s.tenant_id, [p.id]), await availableQuantities(c.env, s.tenant_id, [p.id])));
});

// ── Preisvorschau ────────────────────────────────────────────────────────
const QuoteBody = z.object({ sku_id: z.string().startsWith("sku_"), qty: z.number().int().positive().max(100_000) }).strict();

customerApiRoutes.post("/quotes", async (c) => {
  const s = session(c, "read");
  const parsed = QuoteBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const db = getDb(c.env.DB);
  const p = await productsRepo.findById(db, s.tenant_id, parsed.data.sku_id);
  if (!p || p.status !== "active") throw new CodedError("GH-PROD-001");
  const checked_at = new Date().toISOString();
  const r = await resolvePricingFromDb(db, { tenant_id: s.tenant_id, customer_id: s.customer_id, sku_id: p.id, qty: parsed.data.qty, on_date: checked_at });
  return c.json({
    sku_id: p.id,
    name: p.name,
    qty: parsed.data.qty,
    unit_price_cents: r.unit_price_cents,
    total_cents: r.unit_price_cents * parsed.data.qty,
    currency: r.currency,
    net: true,
    checked_at,
  });
});

// ── Bestellungen ─────────────────────────────────────────────────────────
const OperationId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const OrderBody = z.object({
  operation_id: OperationId.optional(),
  lines: z.array(z.object({ sku_id: z.string().startsWith("sku_"), qty: z.number().int().positive().max(100_000) }).strict()).min(1).max(100),
}).strict();

customerApiRoutes.post("/orders", async (c) => {
  const s = session(c, "write");
  const parsed = OrderBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const { lines, operation_id } = parsed.data;
  const id = newId("order");
  // Kein Rückgriff auf einen offenen Entwurf: ein neuer Warenkorb ist ein neuer
  // Auftrag. Die Wiederaufnahme nach Antwortverlust läuft über operation_id.
  const result = await checkout(c, s, operation_id, { kind: "draft", order_id: id }, lines, async () => {
    const doc = await orders.createDraft(c.env, s, lines, "mobile_app", id);
    return viewOrder(c, s, doc.meta.id);
  });
  return c.json(result, 201);
});

async function checkout<T>(
  c: Context<AppContext>, s: orders.CustomerSession, operationId: string | undefined,
  operation: Pick<CheckoutOperation, "order_id" | "kind">, payload: unknown, execute: () => Promise<T>,
): Promise<T> {
  if (!operationId) return execute();
  const key = OperationId.safeParse(c.req.header("X-Idempotency-Key"));
  if (!key.success) throw new CodedError("GH-INPUT-001", { field: "X-Idempotency-Key" });
  await settlePending(c.env, s, (order_id) => viewOrder(c, s, order_id));
  return runOperation(c.env, s, operationId, key.data, operation, payload, execute);
}

async function viewOrder(c: Context<AppContext>, s: orders.CustomerSession, id: string) {
  const { doc, etag } = await orders.requireOwn(c.env, s, id);
  const view = await orders.view(c.env, s, doc);
  const reserved = doc.plan.executed_steps.find((step) => step.type === "reserve_stock" && !step.error_code);
  const expires = reserved && doc.state.current === "awaiting_confirmation"
    ? new Date(Date.parse(reserved.started_at) + 7_200_000).toISOString() : undefined;
  return { ...view, revision: etag, reservation_expires_at: expires };
}

const ConfirmBody = z.object({ operation_id: OperationId.optional(), expected_revision: z.string().min(1).max(128).optional() }).strict();

customerApiRoutes.post("/orders/:id/confirm", async (c) => {
  const s = session(c, "write");
  const id = c.req.param("id");
  const parsed = ConfirmBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const { operation_id, expected_revision } = parsed.data;
  if (operation_id && !expected_revision) throw new CodedError("GH-INPUT-001", { field: "expected_revision" });
  const current = await viewOrder(c, s, id);
  if (operation_id && !await readOperation(c.env, s, operation_id)) {
    if (expected_revision !== current.revision) throw new CodedError("GH-ORDER-002");
    if (current.reservation_expires_at && Date.parse(current.reservation_expires_at) <= Date.now()) {
      throw new CodedError("GH-STOCK-002");
    }
  }
  return c.json(await checkout(c, s, operation_id, { kind: "confirm", order_id: id }, { id, expected_revision }, async () => {
    await orders.confirm(c.env, s, id, expected_revision);
    return viewOrder(c, s, id);
  }));
});

const CancelBody = z.object({ reason: z.string().max(200).optional(), operation_id: OperationId.optional() }).strict();

customerApiRoutes.post("/orders/:id/cancel", async (c) => {
  const s = session(c, "write");
  const parsed = CancelBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const id = c.req.param("id");
  await orders.requireOwn(c.env, s, id);
  const { operation_id, reason } = parsed.data;
  return c.json(await checkout(c, s, operation_id, { kind: "cancel", order_id: id }, { id, reason }, async () => {
    await orders.cancel(c.env, s, id, reason);
    return viewOrder(c, s, id);
  }));
});

const OrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(500).optional(),
});

customerApiRoutes.get("/orders", async (c) => {
  const s = session(c, "read");
  const parsed = OrdersQuery.safeParse(c.req.query());
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const limit = parsed.data.limit ?? 20;
  const cursor = await parseCursor(c.env, parsed.data.cursor);
  const { items, next_cursor } = await ordersRepo.list(getDb(c.env.DB), s.tenant_id, { customer_id: s.customer_id, cursor, limit });
  return c.json({
    items: items.map((r) => ({ id: r.id, state: r.state_current, total_cents: r.total_cents, currency: r.currency, created_at: r.created_at })),
    next_cursor: next_cursor ? await signCursor(c.env, next_cursor) : null,
  });
});

customerApiRoutes.get("/orders/:id", async (c) => {
  const s = session(c, "read");
  return c.json(await viewOrder(c, s, c.req.param("id")));
});

customerApiRoutes.get("/order-operations/:id", async (c) => {
  const s = session(c, "read");
  const id = c.req.param("id");
  const operation = await readOperation(c.env, s, id);
  if (!operation) return c.json({ operation_id: id, repeat_allowed: true, state: "not_recorded" });
  const saved = operation.response_json ? JSON.parse(operation.response_json) as { id: string } : undefined;
  if (!saved) {
    // Nur lesen: abgeschlossen wird der Vorgang auf dem nächsten Schreibweg (settlePending).
    const record = await ordersRepo.findById(getDb(c.env.DB), s.tenant_id, operation.order_id);
    if (!record || record.doc.customer_id !== s.customer_id || !isSettled(operation.kind, record.doc.state.current)) {
      return c.json({ operation_id: id, repeat_allowed: false, state: "pending" });
    }
  }
  const order = await viewOrder(c, s, saved?.id ?? operation.order_id);
  return c.json({ operation_id: id, repeat_allowed: false, state: "completed", order });
});

customerApiRoutes.get("/orders/:id/invoice", async (c) => {
  const s = session(c, "read");
  const r = await orders.requireOwn(c.env, s, c.req.param("id"));
  const refs = r.doc.external_refs as Record<string, unknown>;
  const key = refs.invoice_pdf_r2_key;
  if (typeof key !== "string" || !key) throw new CodedError("GH-PDF-003");
  const obj = await c.env.ASSETS.get(key);
  // Bestellung sagt „Rechnung da“, R2 hat sie nicht: ein Serverfehler, kein „gibt es nicht“.
  if (!obj) throw new CodedError("GH-PDF-001", { reason: "invoice_object_missing" });
  const number = typeof refs.invoice_number === "string" ? refs.invoice_number : "rechnung";
  return new Response(obj.body as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
});
