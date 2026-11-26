import type { Env } from "../env";
import type { OrderDoc, Step, StepType, ExecutedStep, OrderState } from "../schemas/order";
import { canTransition } from "./state-machine";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import * as customersRepo from "../repos/customers";
import * as productsRepo from "../repos/products";
import { resolvePricingFromDb } from "../services/pricing-resolver";
import { resolveTaxFromDb } from "../services/tax-resolver";
import * as stockSvc from "../services/stock";
import { evaluateGates, blockingFromGates, type GateContext } from "./gates";
import { roundHalfToEvenInt } from "../engines/pricing";
import { eq, and, isNull } from "drizzle-orm";
import { orders } from "../db/schema/orders";
import { warehouses } from "../db/schema/stock";
import { cancelPurchaseRequests, createPurchaseRequests, lineSource, sourceForLine, type LineSource } from "../sourcing/fulfil";

export interface HandlerContext {
  env: Env;
  step: Step;
  now: string;
}

export interface HandlerResult {
  doc: OrderDoc;
  decision_reason?: string;
  result_summary?: Record<string, unknown>;
  blocked?: boolean;
}

type Handler = (doc: OrderDoc, ctx: HandlerContext) => Promise<HandlerResult>;

function appendExecuted(doc: OrderDoc, step: Step, started: string, ended: string, reason?: string, summary?: Record<string, unknown>, error_code?: string): OrderDoc {
  const next: OrderDoc = {
    ...doc,
    plan: {
      ...doc.plan,
      next_steps: doc.plan.next_steps.filter((s) => s.id !== step.id),
      executed_steps: [
        ...doc.plan.executed_steps,
        { step_id: step.id, type: step.type, started_at: started, ended_at: ended, decision_reason: reason, result_summary: summary, error_code } as ExecutedStep,
      ],
    },
  };
  return next;
}

function transition(doc: OrderDoc, to: OrderState, by_step_id: string, ts: string): OrderDoc {
  if (!canTransition(doc.state.current, to)) {
    throw new CodedError("GH-STATE-001", { from: doc.state.current, to });
  }
  return {
    ...doc,
    state: {
      current: to,
      history: [...doc.state.history, { from: doc.state.current, to, by_step_id, ts }],
    },
  };
}

function moveToHold(doc: OrderDoc, blocking: OrderDoc["issues"]["blocking"]): OrderDoc {
  if (doc.state.current === "on_hold") return { ...doc, issues: { ...doc.issues, blocking: [...doc.issues.blocking, ...blocking] } };
  return {
    ...doc,
    state: {
      current: "on_hold",
      history: [...doc.state.history, { from: doc.state.current, to: "on_hold", ts: new Date().toISOString() }],
    },
    issues: { ...doc.issues, blocking: [...doc.issues.blocking, ...blocking] },
  };
}

const resolveHandler: Handler = async (doc, { env, step, now }) => {
  const started = now;
  const db = getDb(env.DB);
  const newLines = await Promise.all(doc.lines.map(async (line) => {
    const sku = await productsRepo.requireById(db, doc.meta.tenant_id, line.sku_id);
    const pricing = await resolvePricingFromDb(db, {
      tenant_id: doc.meta.tenant_id,
      customer_id: doc.customer_id,
      sku_id: line.sku_id,
      qty: line.qty,
      on_date: now,
    });
    const customer = await customersRepo.requireById(db, doc.meta.tenant_id, doc.customer_id);
    // Tenant-Land via tenants-Tabelle laden
    const { tenants } = await import("../db/schema/tenants");
    const trow = (await db.select().from(tenants).where(and(eq(tenants.id, doc.meta.tenant_id), isNull(tenants.deleted_at))).limit(1))[0];
    if (!trow) throw new CodedError("GH-TENANT-001");
    const tax = await resolveTaxFromDb(db, doc.meta.tenant_id, {
      tenant_country: trow.country,
      customer_country: customer.country,
      b2b_b2c: customer.b2b_b2c as "b2b" | "b2c",
      vat_status: customer.vat_status as "valid" | "invalid" | "unknown" | "not_required",
      sku_tax_class: sku.tax_class as "standard" | "reduced" | "zero",
      on_date: now,
    });
    // Integer-skaliertes Banker-Rounding für Tax (#M-003): rate_pct auf Skala 10000.
    const lineSubtotal = pricing.unit_price_cents * line.qty;
    const rateScaled = Math.round(tax.rate_pct * 100); // 19.5 → 1950
    const lineTax = roundHalfToEvenInt(lineSubtotal * rateScaled, 10000);
    const lineTotal = lineSubtotal + lineTax;
    return {
      ...line,
      unit_price_cents: pricing.unit_price_cents,
      tax_scheme: tax.scheme,
      tax_rate_pct: tax.rate_pct,
      tax_rule_id: tax.rule_id,
      line_total_cents: lineTotal,
      resolution: {
        pricing,
        tax,
      },
    };
  }));
  const subtotal = newLines.reduce((acc, l) => acc + (l.unit_price_cents ?? 0) * l.qty, 0);
  const taxTotal = newLines.reduce((acc, l) => acc + ((l.line_total_cents ?? 0) - (l.unit_price_cents ?? 0) * l.qty), 0);
  const totalCents = subtotal + taxTotal;
  const currency = doc.totals.currency;
  let next: OrderDoc = {
    ...doc,
    lines: newLines,
    totals: { ...doc.totals, subtotal_cents: subtotal, tax_cents: taxTotal, total_cents: totalCents, currency },
  };
  if (doc.state.current === "draft") {
    next = transition(next, "resolving", step.id, now);
  }
  next = appendExecuted(next, step, started, new Date().toISOString(), "resolve_pricing_tax", { lines: newLines.length, total_cents: totalCents });
  return { doc: next, decision_reason: "pricing+tax_resolved" };
};

const validateGatesHandler: Handler = async (doc, { env, step, now }) => {
  const db = getDb(env.DB);
  const customer = await customersRepo.requireById(db, doc.meta.tenant_id, doc.customer_id);
  // Outstanding-Total = grobe v1 Schätzung: 0 (M22+ liefert echte Berechnung).
  const ctx: GateContext = {
    customer: {
      id: customer.id,
      blocked: customer.blocked,
      credit_limit_cents: customer.credit_limit_cents,
      vat_status: customer.vat_status,
    },
    outstanding_total_cents: 0,
  };
  const gates = evaluateGates(doc, ctx);
  const blocking = blockingFromGates(gates);
  let next = doc;
  next = { ...next, gates_log: { ...next.gates_log, [step.id]: gates } };
  if (blocking.length > 0) {
    next = moveToHold(next, blocking);
    next = appendExecuted(next, step, now, new Date().toISOString(), "gate_failure", { blocking }, "GH-ORDER-003");
    return { doc: next, blocked: true, decision_reason: "gate_failure", result_summary: { blocking } };
  }
  next = appendExecuted(next, step, now, new Date().toISOString(), "gates_passed", { gate_count: gates.length });
  return { doc: next, decision_reason: "gates_passed" };
};

const reserveStockHandler: Handler = async (doc, { env, step, now }) => {
  const db = getDb(env.DB);
  const { fefoCheck } = await import("../services/fefo");
  // Ohne warehouse_id (MCP-Entwürfe tragen keines) gilt das Standardlager des
  // Tenants. Bis 2026-11-17 hieß der Rückfall fest "wh_default" — ein Lager,
  // das es nirgends gibt: jede MCP-Bestellung lief ins Leere (GH-FEFO-001).
  const defaultWh = (step.args.default_warehouse_id as string | undefined)
    ?? (await db.select({ id: warehouses.id }).from(warehouses)
      .where(and(eq(warehouses.tenant_id, doc.meta.tenant_id), eq(warehouses.is_default, 1))).limit(1))[0]?.id
    ?? "wh_default";
  const whOf = (line: OrderDoc["lines"][number]) => line.warehouse_id ?? defaultWh;

  // EIN FEHLENDER BESTAND IST EIN GESCHÄFTSZUSTAND, KEIN ABSTURZ. Bis 2026-11-17
  // warf dieser Handler mitten in der Kette: der Client bekam 422, das Dokument
  // blieb trotzdem als `resolving` gespeichert, und Reservierungen früherer
  // Zeilen hingen bis zum TTL. Jetzt wie bei Gate-Fehlern (M10-Akzeptanz):
  // `on_hold` mit `issues.blocking`, nichts bleibt reserviert.

  // Phase 1: FEFO für ALLE Zeilen, bevor irgendetwas reserviert wird.
  const fefoByLine = new Map<number, Awaited<ReturnType<typeof fefoCheck>>>();
  const fefoBlocking: Array<{ code: string; detail: string; line_no: number }> = [];
  // Positionen, die mangels eigenem Bestand aus einer Lieferanten-Quelle kommen (Quellenmix).
  const supplied = new Map<number, LineSource>();
  for (const line of doc.lines) {
    const fefo = await fefoCheck(db, {
      tenant_id: doc.meta.tenant_id,
      warehouse_id: whOf(line),
      sku_id: line.sku_id,
      qty: line.qty,
      on_date: now,
    });
    fefoByLine.set(line.line_no, fefo);
    if (!fefo.ok && fefo.product_is_perishable) {
      const src = await sourceForLine(env, doc.meta.tenant_id, line.sku_id, line.qty);
      if (src) { supplied.set(line.line_no, src); continue; }
      fefoBlocking.push({
        code: "GH-FEFO-001",
        detail: `${line.sku_id}: ${line.qty} angefordert, mit Restlaufzeit verfügbar ${fefo.total_eligible}`,
        line_no: line.line_no,
      });
    }
  }
  if (fefoBlocking.length > 0) {
    let held = moveToHold(doc, fefoBlocking);
    held = appendExecuted(held, step, now, new Date().toISOString(), "fefo_insufficient", { blocking: fefoBlocking.length }, "GH-FEFO-001");
    return { doc: held, blocked: true };
  }

  // Phase 2: reservieren. Reicht der Bestand nicht, alles bisher Reservierte freigeben.
  const newLines: OrderDoc["lines"] = [];
  const fefoSummary: Array<{ line_no: number; perishable: boolean; eligible: number }> = [];
  for (const line of doc.lines) {
    const wh = whOf(line);
    const fefo = fefoByLine.get(line.line_no)!;
    fefoSummary.push({ line_no: line.line_no, perishable: fefo.product_is_perishable, eligible: fefo.total_eligible });
    const pre = supplied.get(line.line_no);
    if (pre) {
      newLines.push({ ...line, warehouse_id: wh, reservation_id: null, resolution: { ...line.resolution, sourcing: pre } });
      continue;
    }
    let reservation;
    try {
      reservation = await stockSvc.reserve(env, {
        tenant_id: doc.meta.tenant_id,
        warehouse_id: wh,
        sku_id: line.sku_id,
        qty: line.qty,
        ttl_sec: 7200,
        idempotency_key: `${doc.meta.id}:${line.line_no}`,
        customer_id: doc.customer_id,
      });
    } catch (err) {
      if (!(err instanceof CodedError) || err.code !== "GH-STOCK-001") throw err;
      const src = await sourceForLine(env, doc.meta.tenant_id, line.sku_id, line.qty);
      if (src) {
        supplied.set(line.line_no, src);
        newLines.push({ ...line, warehouse_id: wh, reservation_id: null, resolution: { ...line.resolution, sourcing: src } });
        continue;
      }
      for (const done of newLines) {
        if (!done.reservation_id) continue;
        await stockSvc.release(env, { tenant_id: doc.meta.tenant_id, warehouse_id: done.warehouse_id ?? wh, sku_id: done.sku_id, reservation_id: done.reservation_id });
      }
      const blocking = [{ code: "GH-STOCK-001", detail: `${line.sku_id}: ${line.qty} angefordert, Bestand reicht nicht`, line_no: line.line_no }];
      let held = moveToHold(doc, blocking);
      held = appendExecuted(held, step, now, new Date().toISOString(), "stock_insufficient", { released: newLines.length }, "GH-STOCK-001");
      return { doc: held, blocked: true };
    }
    newLines.push({
      ...line,
      warehouse_id: wh,
      reservation_id: reservation.reservation_id,
      resolution: { ...line.resolution, fefo_allocations: fefo.allocations },
    });
  }
  let next: OrderDoc = { ...doc, lines: newLines };
  next = appendExecuted(next, step, now, new Date().toISOString(), supplied.size ? "stock_reserved_with_supplier_lines" : "stock_reserved_fefo_checked",
    { lines: newLines.length, fefo: fefoSummary, supplier_lines: supplied.size });
  return { doc: next };
};

const awaitConfirmationHandler: Handler = async (doc, { step, now }) => {
  let next = doc;
  if (doc.state.current === "resolving") {
    next = transition(next, "awaiting_confirmation", step.id, now);
  }
  next = appendExecuted(next, step, now, new Date().toISOString(), "awaiting_confirmation");
  return { doc: next };
};

const commitStockHandler: Handler = async (doc, { env, step, now }) => {
  for (const line of doc.lines) {
    if (lineSource(line)) continue;
    if (!line.reservation_id) throw new CodedError("GH-STOCK-002", { line_no: line.line_no });
    const wh = line.warehouse_id ?? "wh_default";
    await stockSvc.commit(env, {
      tenant_id: doc.meta.tenant_id,
      warehouse_id: wh,
      sku_id: line.sku_id,
      reservation_id: line.reservation_id,
      idempotency_key: `${doc.meta.id}:commit:${line.line_no}`,
    });
  }
  const requests = await createPurchaseRequests(env, doc);
  let next = doc;
  if (doc.state.current === "awaiting_confirmation") {
    next = transition(next, "confirmed", step.id, now);
  }
  next = appendExecuted(next, step, now, new Date().toISOString(), "stock_committed", requests ? { purchase_requests: requests } : undefined);
  return { doc: next };
};

const releaseStockHandler: Handler = async (doc, { env, step, now }) => {
  for (const line of doc.lines) {
    if (!line.reservation_id) continue;
    const wh = line.warehouse_id ?? "wh_default";
    try {
      await stockSvc.release(env, {
        tenant_id: doc.meta.tenant_id,
        warehouse_id: wh,
        sku_id: line.sku_id,
        reservation_id: line.reservation_id,
      });
    } catch {
      // Best-Effort: Reservation kann bereits abgelaufen sein.
    }
  }
  await cancelPurchaseRequests(env, doc.meta.tenant_id, doc.meta.id);
  let next = doc;
  if (canTransition(doc.state.current, "cancelled")) {
    next = transition(next, "cancelled", step.id, now);
  }
  next = appendExecuted(next, step, now, new Date().toISOString(), "stock_released");
  return { doc: next };
};

const emitEventHandler: Handler = async (doc, { step, now }) => {
  // Outbox-Tx (M12): das Event wird NICHT hier geschrieben, sondern in
  // `external_refs._pending_emits` abgelegt; ordersRepo.update fügt es im
  // selben D1-Batch wie das Order-UPDATE ein (alles oder nichts), und
  // runNextStep schiebt es danach in die Queue.
  //
  // Bis 2026-11-17 rief dieser Handler `outbox.emit()` OHNE env auf. Das wirft
  // seit #C-003, und ein leeres `catch {}` schluckte es: kein einziges
  // order.*-Event wurde je geschrieben, und der Schritt stand trotzdem als
  // ausgeführt im Plan. Aufgefallen beim ersten Lauf gegen echtes D1.
  const topic = (step.args.topic as string) ?? "order.unknown.v1";
  const refs = doc.external_refs as Record<string, unknown>;
  const pending = (refs._pending_emits as Array<{ topic: string; payload: Record<string, unknown> }> | undefined) ?? [];
  let next: OrderDoc = {
    ...doc,
    external_refs: {
      ...refs,
      // Nutzlast wie vorher an emit(): das Order-Dokument (ohne die Warteschlange selbst).
      _pending_emits: [...pending, { topic, payload: { ...doc, external_refs: { ...refs, _pending_emits: undefined } } as unknown as Record<string, unknown> }],
    },
  };
  next = appendExecuted(next, step, now, new Date().toISOString(), `emit_${topic}`, { topic });
  return { doc: next };
};

const generateInvoiceHandler: Handler = async (doc, { env, step, now }) => {
  try {
    const { generateForOrder } = await import("../services/invoice");
    const inv = await generateForOrder(env, { tenant_id: doc.meta.tenant_id, order_id: doc.meta.id });
    let next = doc;
    next = { ...next, external_refs: { ...next.external_refs, invoice_id: inv.id, invoice_number: inv.invoice_number, invoice_pdf_r2_key: inv.r2_key } };
    next = appendExecuted(next, step, now, new Date().toISOString(), "invoice_generated", { invoice_number: inv.invoice_number });
    return { doc: next };
  } catch (err) {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "invoice_generation_failed", { error: err instanceof Error ? err.message : String(err) }, "GH-PDF-001");
    return { doc: next };
  }
};

export const HANDLERS: Record<StepType, Handler> = {
  resolve: resolveHandler,
  validate_gates: validateGatesHandler,
  reserve_stock: reserveStockHandler,
  commit_stock: commitStockHandler,
  release_stock: releaseStockHandler,
  await_confirmation: awaitConfirmationHandler,
  emit_event: emitEventHandler,
  generate_invoice: generateInvoiceHandler,
  state_transition: async (doc, { step, now }) => {
    const to = step.args.to as OrderState | undefined;
    if (!to) throw new CodedError("GH-INPUT-001", { reason: "state_transition.args.to required" });
    let next = transition(doc, to, step.id, now);
    next = appendExecuted(next, step, now, new Date().toISOString(), `state→${to}`);
    return { doc: next };
  },
  audit_append: async (doc, { step, now }) => {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "audit_append", step.args as Record<string, unknown>);
    return { doc: next };
  },
  user_interaction: async (doc, { step, now }) => {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "user_interaction_break");
    return { doc: next };
  },
  external_call: async (doc, { step, now }) => {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "external_call_break");
    return { doc: next };
  },
  queue_message: async (doc, { step, now }) => {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "queue_message");
    return { doc: next };
  },
  webhook: async (doc, { step, now }) => {
    const next = appendExecuted(doc, step, now, new Date().toISOString(), "webhook");
    return { doc: next };
  },
};
