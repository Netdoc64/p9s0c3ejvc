import { Hono } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import * as ordersRepo from "../repos/orders";
import * as customersRepo from "../repos/customers";
import { CreateOrderRequestSchema, OrderStateSchema, type OrderDoc } from "../schemas/order";
import { newId } from "../lib/ids";
import { runNextStep } from "../orchestrator";
import { parseCursor, parseLimit, signCursor } from "../lib/http";

export const ordersRoutes = new Hono<AppContext>();

function tenantId(c: import("hono").Context<AppContext>): string {
  const t = c.var.tenant_id;
  if (!t) throw new CodedError("GH-AUTH-001");
  return t;
}

ordersRoutes.post("/", async (c) => {
  const tenant_id = tenantId(c);
  const body = await c.req.json();
  const parsed = CreateOrderRequestSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const customer = await customersRepo.requireById(db, tenant_id, parsed.data.customer_id);

  // Tenant + Currency
  const { tenants } = await import("../db/schema/tenants");
  const { eq, and, isNull } = await import("drizzle-orm");
  const trow = (await db.select().from(tenants).where(and(eq(tenants.id, tenant_id), isNull(tenants.deleted_at))).limit(1))[0];
  if (!trow) throw new CodedError("GH-TENANT-001");

  const order_id = newId("order");
  const now = new Date().toISOString();
  const doc: OrderDoc = {
    meta: {
      schema_version: "order-document/1.0",
      doc_type: "order",
      id: order_id,
      tenant_id,
      parent_order_id: null,
    },
    customer_id: customer.id,
    customer_snapshot: {
      id: customer.id,
      name: customer.name,
      country: customer.country,
      vat_id: customer.vat_id,
      vat_status: customer.vat_status,
      b2b_b2c: customer.b2b_b2c,
    },
    source: { ...(parsed.data.source ?? {}), api_key_id: c.var.api_key_id },
    actor: parsed.data.actor ?? { type: "tenant", id: c.var.api_key_id },
    lines: parsed.data.lines.map((l, i) => ({
      ...l,
      line_no: i + 1,
      unit_price_cents: null,
      tax_scheme: null,
      tax_rate_pct: null,
      tax_rule_id: null,
      line_total_cents: null,
      reservation_id: null,
      resolution: {},
    })),
    totals: { subtotal_cents: 0, tax_cents: 0, total_cents: 0, currency: trow.currency },
    state: { current: "draft", history: [{ from: null, to: "draft", ts: now }] },
    plan: {
      next_steps: [
        { id: "step_resolve", type: "resolve", args: {} },
        { id: "step_validate", type: "validate_gates", args: {} },
        { id: "step_reserve", type: "reserve_stock", args: {} },
        { id: "step_await", type: "await_confirmation", args: {} },
      ],
      executed_steps: [],
    },
    external_refs: {},
    issues: { blocking: [], warnings: [] },
    gates_log: {},
    audit: {},
  };

  await ordersRepo.create(db, doc);
  const result = await runNextStep(c.env, tenant_id, order_id);
  return c.json({ doc: result.doc, etag: result.etag, steps_executed: result.steps_executed }, 201);
});

ordersRoutes.post("/:id/confirm", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const current = await ordersRepo.requireById(db, tenant_id, id);
  if (current.doc.state.current !== "awaiting_confirmation") {
    throw new CodedError("GH-STATE-001", { from: current.doc.state.current, to: "confirmed" });
  }
  // Plan-Steps für Confirm injizieren
  const updated = await ordersRepo.update(db, tenant_id, id, current.etag, (doc) => ({
    ...doc,
    plan: {
      ...doc.plan,
      next_steps: [
        { id: `step_commit_${Date.now()}`, type: "commit_stock" as const, args: {} },
        { id: `step_event_confirmed_${Date.now()}`, type: "emit_event" as const, args: { topic: "order.confirmed.v1" } },
        { id: `step_invoice_${Date.now()}`, type: "generate_invoice" as const, args: {} },
      ],
    },
  }));
  void updated;
  const result = await runNextStep(c.env, tenant_id, id);
  return c.json({ doc: result.doc, etag: result.etag });
});

ordersRoutes.post("/:id/cancel", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  const db = getDb(c.env.DB);
  const current = await ordersRepo.requireById(db, tenant_id, id);
  if (["cancelled", "shipped", "invoiced", "paid"].includes(current.doc.state.current)) {
    throw new CodedError("GH-STATE-001", { from: current.doc.state.current, to: "cancelled" });
  }
  await ordersRepo.update(db, tenant_id, id, current.etag, (doc) => ({
    ...doc,
    plan: {
      ...doc.plan,
      next_steps: [
        { id: `step_release_${Date.now()}`, type: "release_stock" as const, args: { reason: body.reason ?? "cancelled" } },
        { id: `step_event_cancelled_${Date.now()}`, type: "emit_event" as const, args: { topic: "order.cancelled.v1" } },
      ],
    },
    issues: { ...doc.issues, warnings: [...doc.issues.warnings, { code: "cancelled_by_user", detail: body.reason }] },
  }));
  const result = await runNextStep(c.env, tenant_id, id);
  return c.json({ doc: result.doc, etag: result.etag });
});

ordersRoutes.get("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const r = await ordersRepo.requireById(db, tenant_id, id);
  return c.json({ doc: r.doc, etag: r.etag });
});

ordersRoutes.get("/", async (c) => {
  const tenant_id = tenantId(c);
  const db = getDb(c.env.DB);
  const stateRaw = c.req.query("state");
  // Enum-Validation (#Q-002 / #T-011): nur gültige OrderState-Werte akzeptieren.
  let state: string | undefined;
  if (stateRaw !== undefined) {
    const stateParsed = OrderStateSchema.safeParse(stateRaw);
    if (!stateParsed.success) throw new CodedError("GH-INPUT-001", { field: "state", value: stateRaw });
    state = stateParsed.data;
  }
  const customer_id = c.req.query("customer_id") ?? undefined;
  const created_after = c.req.query("created_after") ?? undefined;
  const created_before = c.req.query("created_before") ?? undefined;
  const limit = parseLimit(c.req.query("limit"));
  const cursor = await parseCursor(c.env, c.req.query("cursor"));
  const result = await ordersRepo.list(db, tenant_id, { state, customer_id, created_after, created_before, cursor, limit });
  return c.json({
    items: result.items.map((r) => ({ id: r.id, customer_id: r.customer_id, state: r.state_current, total_cents: r.total_cents, currency: r.currency, created_at: r.created_at })),
    next_cursor: result.next_cursor ? await signCursor(c.env, result.next_cursor) : null,
  });
});
