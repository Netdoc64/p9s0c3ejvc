/**
 * Bestellungen aus Kundensicht — gemeinsam für die Kunden-REST-API
 * (`/v1/customer`) und den MCP-Endpunkt. Beide sprechen mit einem
 * Kunden-Token; Tenant und Kunde kommen IMMER aus der geprüften Sitzung,
 * nie aus dem Request.
 *
 * Zwei Regeln, die hier und nirgends sonst durchgesetzt werden:
 *
 * 1. EIGENTUM. Jede Bestellung wird nur gelesen oder verändert, wenn sie dem
 *    Kunden der Sitzung gehört. Eine fremde Bestellung ist „nicht gefunden“
 *    (GH-ORDER-001), nicht „verboten“ — sonst verrät die Antwort, dass es sie gibt.
 *
 * 2. SICHTBARKEIT (Build-Plan G3). Das Order-Dokument trägt interne Teile
 *    (`plan`, `audit`, `gates_log`, Lager, Reservierungen, Auflösungsdetails).
 *    Nach außen geht nur `toCustomerView` — eine Positivliste, keine Negativliste:
 *    ein neues internes Feld bleibt drinnen, bis es jemand ausdrücklich freigibt.
 */
import type { Env } from "../env";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { tenants } from "../db/schema/tenants";
import { products } from "../db/schema/products";
import * as customersRepo from "../repos/customers";
import * as ordersRepo from "../repos/orders";
import { CodedError } from "../errors/catalog";
import { canTransition, type OrderDoc, type OrderState } from "../schemas/order";
import { newId } from "../lib/ids";
import { runNextStep } from "../orchestrator";

export interface CustomerSession { tenant_id: string; customer_id: string }

export interface CustomerOrderView {
  id: string;
  state: OrderState;
  created_at: string | null;
  currency: string;
  lines: Array<{
    line_no: number;
    sku_id: string;
    name: string | null;
    qty: number;
    unit_price_cents: number | null;
    tax_rate_pct: number | null;
    line_total_cents: number | null;
  }>;
  totals: { subtotal_cents: number; tax_cents: number; total_cents: number };
  invoice: { number: string; available: true } | null;
  /** Was der Kunde mit dieser Bestellung jetzt tun kann. */
  allowed_actions: Array<"confirm" | "cancel">;
  /** Warum eine Bestellung angehalten ist — Code und lesbarer Grund je Position. */
  blocking: Array<{ code: string; detail?: string; line_no?: number }>;
}

/**
 * Kunden dürfen nur stornieren, was noch nicht verbindlich ist. Eine
 * bestätigte Bestellung hat Bestand verbucht und eine Rechnung mit
 * lückenloser Nummer — deren Storno gehört dem Händler (Tenant-API) und
 * braucht eine Gutschrift (D03).
 */
const CUSTOMER_CANCELLABLE: ReadonlySet<OrderState> = new Set(["draft", "resolving", "awaiting_confirmation", "on_hold"]);

export function allowedActions(state: OrderState): Array<"confirm" | "cancel"> {
  const out: Array<"confirm" | "cancel"> = [];
  if (state === "awaiting_confirmation") out.push("confirm");
  if (CUSTOMER_CANCELLABLE.has(state) && canTransition(state, "cancelled")) out.push("cancel");
  return out;
}

export function toCustomerView(doc: OrderDoc, names: Record<string, string> = {}): CustomerOrderView {
  const refs = doc.external_refs as Record<string, unknown>;
  const invoiceNumber = typeof refs.invoice_number === "string" ? refs.invoice_number : null;
  const firstState = doc.state.history[0] as { ts?: string } | undefined;
  return {
    id: doc.meta.id,
    state: doc.state.current,
    created_at: firstState?.ts ?? null,
    currency: doc.totals.currency,
    lines: doc.lines.map((l) => ({
      line_no: l.line_no,
      sku_id: l.sku_id,
      name: names[l.sku_id] ?? null,
      qty: l.qty,
      unit_price_cents: l.unit_price_cents ?? null,
      tax_rate_pct: l.tax_rate_pct ?? null,
      line_total_cents: l.line_total_cents ?? null,
    })),
    totals: { subtotal_cents: doc.totals.subtotal_cents, tax_cents: doc.totals.tax_cents, total_cents: doc.totals.total_cents },
    invoice: invoiceNumber ? { number: invoiceNumber, available: true } : null,
    allowed_actions: allowedActions(doc.state.current),
    blocking: doc.issues.blocking.map((b) => ({ code: b.code, ...(b.detail ? { detail: b.detail } : {}), ...(b.line_no ? { line_no: b.line_no } : {}) })),
  };
}

/** Produktnamen für eine Ansicht nachladen (mandantengetrennt). */
export async function productNames(env: Env, tenant_id: string, skuIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(skuIds)];
  if (ids.length === 0) return {};
  const db = getDb(env.DB);
  const rows = await db.select({ id: products.id, name: products.name }).from(products)
    .where(and(eq(products.tenant_id, tenant_id), inArray(products.id, ids)));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

export async function view(env: Env, s: CustomerSession, doc: OrderDoc): Promise<CustomerOrderView> {
  return toCustomerView(doc, await productNames(env, s.tenant_id, doc.lines.map((l) => l.sku_id)));
}

/** Eigene Bestellung laden — fremde und unbekannte sind gleichermaßen „nicht gefunden“. */
export async function requireOwn(env: Env, s: CustomerSession, order_id: string): Promise<{ doc: OrderDoc; etag: string }> {
  const db = getDb(env.DB);
  const r = await ordersRepo.findById(db, s.tenant_id, order_id);
  if (!r || r.doc.customer_id !== s.customer_id) throw new CodedError("GH-ORDER-001");
  return r;
}

export async function createDraft(
  env: Env,
  s: CustomerSession,
  lines: Array<{ sku_id: string; qty: number }>,
  channel: "mobile_app" | "mcp",
  order_id = newId("order"),
): Promise<OrderDoc> {
  const db = getDb(env.DB);
  const customer = await customersRepo.requireById(db, s.tenant_id, s.customer_id);
  const trow = (await db.select().from(tenants).where(and(eq(tenants.id, s.tenant_id), isNull(tenants.deleted_at))).limit(1))[0];
  if (!trow) throw new CodedError("GH-TENANT-001");
  const now = new Date().toISOString();
  const doc: OrderDoc = {
    meta: { schema_version: "order-document/1.0", doc_type: "order", id: order_id, tenant_id: s.tenant_id, parent_order_id: null },
    customer_id: customer.id,
    customer_snapshot: { id: customer.id, name: customer.name, country: customer.country, b2b_b2c: customer.b2b_b2c, vat_id: customer.vat_id, vat_status: customer.vat_status },
    source: { channel, actor: channel === "mcp" ? "ai_agent" : "customer" },
    actor: { type: "customer", id: s.customer_id },
    lines: lines.map((l, i) => ({ ...l, line_no: i + 1, unit_price_cents: null, tax_scheme: null, tax_rate_pct: null, tax_rule_id: null, line_total_cents: null, reservation_id: null, resolution: {} })),
    totals: { subtotal_cents: 0, tax_cents: 0, total_cents: 0, currency: trow.currency },
    state: { current: "draft", history: [{ from: null, to: "draft", ts: now }] },
    plan: { next_steps: [
      { id: "step_resolve", type: "resolve", args: {} },
      { id: "step_validate", type: "validate_gates", args: {} },
      { id: "step_reserve", type: "reserve_stock", args: {} },
      { id: "step_await", type: "await_confirmation", args: {} },
    ], executed_steps: [] },
    external_refs: {},
    issues: { blocking: [], warnings: [] },
    gates_log: {},
    audit: {},
  };
  await ordersRepo.create(db, doc);
  const result = await runNextStep(env, s.tenant_id, order_id);
  return result.doc;
}

export async function confirm(env: Env, s: CustomerSession, order_id: string, expectedRevision?: string): Promise<OrderDoc> {
  const current = await requireOwn(env, s, order_id);
  if (expectedRevision && current.etag !== expectedRevision) throw new CodedError("GH-ORDER-002");
  if (current.doc.plan.next_steps.length > 0) throw new CodedError("GH-STATE-001");
  if (current.doc.state.current !== "awaiting_confirmation") {
    throw new CodedError("GH-STATE-001", { from: current.doc.state.current, to: "confirmed" });
  }
  const db = getDb(env.DB);
  const t = Date.now();
  await ordersRepo.update(db, s.tenant_id, order_id, current.etag, (doc) => ({
    ...doc,
    plan: {
      ...doc.plan,
      next_steps: [
        { id: `step_commit_${t}`, type: "commit_stock" as const, args: {} },
        { id: `step_event_confirmed_${t}`, type: "emit_event" as const, args: { topic: "order.confirmed.v1" } },
        { id: `step_invoice_${t}`, type: "generate_invoice" as const, args: {} },
      ],
    },
  }));
  return (await runNextStep(env, s.tenant_id, order_id)).doc;
}

export async function cancel(env: Env, s: CustomerSession, order_id: string, reason?: string): Promise<OrderDoc> {
  const current = await requireOwn(env, s, order_id);
  if (!allowedActions(current.doc.state.current).includes("cancel")) {
    throw new CodedError("GH-STATE-001", { from: current.doc.state.current, to: "cancelled" });
  }
  const db = getDb(env.DB);
  const t = Date.now();
  await ordersRepo.update(db, s.tenant_id, order_id, current.etag, (doc) => ({
    ...doc,
    plan: {
      ...doc.plan,
      next_steps: [
        { id: `step_release_${t}`, type: "release_stock" as const, args: { reason: reason ?? "cancelled_by_customer" } },
        { id: `step_event_cancelled_${t}`, type: "emit_event" as const, args: { topic: "order.cancelled.v1" } },
      ],
    },
  }));
  return (await runNextStep(env, s.tenant_id, order_id)).doc;
}
