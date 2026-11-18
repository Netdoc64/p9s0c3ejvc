import { and, desc, eq, lt, gt } from "drizzle-orm";
import type { DB } from "../db/client";
import { orders, order_lines, type OrderRow } from "../db/schema/orders";
import { outbox_events } from "../db/schema/webhooks";
import { OrderDocSchema, type OrderDoc } from "../schemas/order";
import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";

export interface PendingOutboxEvent {
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * Outbox-Tx-Atomicity (M12 Plan-Revision):
 * Mutator kann pending outbox-events in `doc.external_refs._pending_emits[]`
 * (oder als Rückgabe-Side-Channel) deklarieren. Diese werden in derselben
 * D1-Batch-Transaktion wie das Order-UPDATE inserted. Crash zwischen den
 * beiden Schritten ist nicht möglich.
 */
function extractPendingEmits(doc: OrderDoc): { doc: OrderDoc; events: PendingOutboxEvent[] } {
  const refs = doc.external_refs as Record<string, unknown>;
  const pending = (refs._pending_emits as PendingOutboxEvent[] | undefined) ?? [];
  if (pending.length === 0) return { doc, events: [] };
  const cleanRefs = { ...refs };
  delete cleanRefs._pending_emits;
  return { doc: { ...doc, external_refs: cleanRefs }, events: pending };
}

function canonicalize(obj: unknown): string {
  // Deterministisch sortierende Serialisierung.
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}

export async function computeEtag(doc: OrderDoc): Promise<string> {
  return sha256Hex(canonicalize(doc));
}

export async function create(db: DB, doc: OrderDoc): Promise<{ doc: OrderDoc; etag: string }> {
  const parsed = OrderDocSchema.parse(doc);
  const etag = await computeEtag(parsed);
  const now = new Date().toISOString();
  await db.insert(orders).values({
    id: parsed.meta.id,
    tenant_id: parsed.meta.tenant_id,
    customer_id: parsed.customer_id,
    doc_type: parsed.meta.doc_type,
    schema_version: parsed.meta.schema_version,
    state_current: parsed.state.current,
    total_cents: parsed.totals.total_cents,
    currency: parsed.totals.currency,
    customer_snapshot: JSON.stringify(parsed.customer_snapshot),
    source: JSON.stringify(parsed.source),
    actor: JSON.stringify(parsed.actor),
    totals: JSON.stringify(parsed.totals),
    plan: JSON.stringify(parsed.plan),
    audit: JSON.stringify(parsed.audit),
    gates_log: JSON.stringify(parsed.gates_log),
    external_refs: JSON.stringify(parsed.external_refs),
    issues: JSON.stringify(parsed.issues),
    state_history: JSON.stringify(parsed.state.history),
    parent_order_id: parsed.meta.parent_order_id ?? null,
    etag,
    created_at: now,
    updated_at: now,
  });
  if (parsed.lines.length > 0) {
    await db.insert(order_lines).values(parsed.lines.map((l) => ({
      id: newId("event"),
      order_id: parsed.meta.id,
      line_no: l.line_no,
      sku_id: l.sku_id,
      warehouse_id: l.warehouse_id ?? null,
      qty: l.qty,
      unit_price_cents: l.unit_price_cents ?? null,
      tax_scheme: l.tax_scheme ?? null,
      tax_rate_pct: l.tax_rate_pct ?? null,
      tax_rule_id: l.tax_rule_id ?? null,
      line_total_cents: l.line_total_cents ?? null,
      reservation_id: l.reservation_id ?? null,
      resolution: JSON.stringify(l.resolution),
      created_at: now,
    })));
  }
  return { doc: parsed, etag };
}

export async function findById(db: DB, tenant_id: string, id: string): Promise<{ doc: OrderDoc; etag: string } | null> {
  const orderRow = (await db.select().from(orders).where(and(eq(orders.id, id), eq(orders.tenant_id, tenant_id))).limit(1))[0];
  if (!orderRow) return null;
  const lineRows = await db.select().from(order_lines).where(eq(order_lines.order_id, id));
  const doc = rowToDoc(orderRow, lineRows);
  return { doc, etag: orderRow.etag };
}

export async function requireById(db: DB, tenant_id: string, id: string): Promise<{ doc: OrderDoc; etag: string }> {
  const r = await findById(db, tenant_id, id);
  if (!r) throw new CodedError("GH-ORDER-001");
  return r;
}

function rowToDoc(o: OrderRow, lines: Array<typeof order_lines.$inferSelect>): OrderDoc {
  const doc: OrderDoc = {
    meta: {
      schema_version: o.schema_version as "order-document/1.0",
      doc_type: o.doc_type as "order",
      id: o.id,
      tenant_id: o.tenant_id,
      parent_order_id: o.parent_order_id,
    },
    customer_id: o.customer_id,
    customer_snapshot: JSON.parse(o.customer_snapshot) as Record<string, unknown>,
    source: JSON.parse(o.source) as Record<string, unknown>,
    actor: JSON.parse(o.actor) as Record<string, unknown>,
    lines: lines.map((l) => ({
      sku_id: l.sku_id,
      qty: l.qty,
      warehouse_id: l.warehouse_id ?? undefined,
      line_no: l.line_no,
      unit_price_cents: l.unit_price_cents ?? null,
      tax_scheme: l.tax_scheme ?? null,
      tax_rate_pct: l.tax_rate_pct ?? null,
      tax_rule_id: l.tax_rule_id ?? null,
      line_total_cents: l.line_total_cents ?? null,
      reservation_id: l.reservation_id ?? null,
      resolution: JSON.parse(l.resolution) as Record<string, unknown>,
    })),
    totals: JSON.parse(o.totals) as { subtotal_cents: number; tax_cents: number; total_cents: number; currency: string },
    state: {
      current: o.state_current as OrderDoc["state"]["current"],
      history: JSON.parse(o.state_history) as OrderDoc["state"]["history"],
    },
    plan: JSON.parse(o.plan) as OrderDoc["plan"],
    external_refs: JSON.parse(o.external_refs) as Record<string, unknown>,
    issues: JSON.parse(o.issues) as OrderDoc["issues"],
    gates_log: JSON.parse(o.gates_log) as Record<string, unknown>,
    audit: JSON.parse(o.audit) as Record<string, unknown>,
  };
  return doc;
}

export interface UpdateResult {
  doc: OrderDoc;
  etag: string;
  emitted_event_ids: string[];
}

export async function update(db: DB, tenant_id: string, id: string, expected_etag: string, mutator: (doc: OrderDoc) => OrderDoc | Promise<OrderDoc>): Promise<UpdateResult> {
  const current = await requireById(db, tenant_id, id);
  if (current.etag !== expected_etag) throw new CodedError("GH-ORDER-002");
  const mutated = await mutator(current.doc);

  // Pending outbox-events extrahieren — diese werden ATOMIC mit dem UPDATE inserted.
  const { doc: cleanDoc, events: pendingEmits } = extractPendingEmits(mutated);
  const validated = OrderDocSchema.parse(cleanDoc);
  const new_etag = await computeEtag(validated);
  const now = new Date().toISOString();
  const emittedIds: string[] = [];

  // Build atomic batch: UPDATE orders + DELETE order_lines + INSERT order_lines + INSERT outbox_events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmts: any[] = [];
  stmts.push(buildOrderUpdateStmt(db, id, expected_etag, validated, new_etag, now));
  stmts.push(db.delete(order_lines).where(eq(order_lines.order_id, id)));
  if (validated.lines.length > 0) {
    stmts.push(db.insert(order_lines).values(validated.lines.map((l) => ({
      id: newId("event"),
      order_id: id,
      line_no: l.line_no,
      sku_id: l.sku_id,
      warehouse_id: l.warehouse_id ?? null,
      qty: l.qty,
      unit_price_cents: l.unit_price_cents ?? null,
      tax_scheme: l.tax_scheme ?? null,
      tax_rate_pct: l.tax_rate_pct ?? null,
      tax_rule_id: l.tax_rule_id ?? null,
      line_total_cents: l.line_total_cents ?? null,
      reservation_id: l.reservation_id ?? null,
      resolution: JSON.stringify(l.resolution),
      created_at: now,
    }))));
  }
  for (const evt of pendingEmits) {
    const event_id = newId("event");
    emittedIds.push(event_id);
    stmts.push(db.insert(outbox_events).values({
      id: event_id,
      tenant_id,
      topic: evt.topic,
      aggregate_id: id,
      payload: JSON.stringify(evt.payload),
      status: "pending",
      attempt: 0,
      created_at: now,
    }));
  }

  // D1.batch ist atomar (alle oder keiner). drizzle-d1 exposes db.batch([...]).
  // #Q-003: Production muss db.batch nutzen; Fallback ist nur für In-Memory-Tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  if (typeof dbAny.batch === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await dbAny.batch(stmts) as Array<{ meta?: { rows_written?: number; changes?: number } } | unknown>;
    const first = results[0] as { meta?: { changes?: number } } | undefined;
    if (first?.meta && typeof first.meta.changes === "number" && first.meta.changes === 0) {
      throw new CodedError("GH-ORDER-002");
    }
  } else {
    // Test-Fallback: sequenziell. Production MUST haben db.batch.
    for (const s of stmts) await s;
  }

  return { doc: validated, etag: new_etag, emitted_event_ids: emittedIds };
}

function buildOrderUpdateStmt(db: DB, id: string, expected_etag: string, validated: OrderDoc, new_etag: string, now: string) {
  return db.update(orders).set({
    state_current: validated.state.current,
    total_cents: validated.totals.total_cents,
    currency: validated.totals.currency,
    customer_snapshot: JSON.stringify(validated.customer_snapshot),
    source: JSON.stringify(validated.source),
    actor: JSON.stringify(validated.actor),
    totals: JSON.stringify(validated.totals),
    plan: JSON.stringify(validated.plan),
    audit: JSON.stringify(validated.audit),
    gates_log: JSON.stringify(validated.gates_log),
    external_refs: JSON.stringify(validated.external_refs),
    issues: JSON.stringify(validated.issues),
    state_history: JSON.stringify(validated.state.history),
    etag: new_etag,
    updated_at: now,
  }).where(and(eq(orders.id, id), eq(orders.etag, expected_etag)));
}

export interface ListParams {
  state?: string;
  customer_id?: string;
  created_after?: string;
  created_before?: string;
  cursor?: { created_at: string; id: string };
  limit?: number;
}

export async function list(db: DB, tenant_id: string, params: ListParams = {}): Promise<{ items: OrderRow[]; next_cursor: { created_at: string; id: string } | null }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conds = [eq(orders.tenant_id, tenant_id)];
  if (params.state) conds.push(eq(orders.state_current, params.state));
  if (params.customer_id) conds.push(eq(orders.customer_id, params.customer_id));
  if (params.created_after) conds.push(gt(orders.created_at, params.created_after));
  if (params.created_before) conds.push(lt(orders.created_at, params.created_before));
  if (params.cursor) conds.push(lt(orders.created_at, params.cursor.created_at));
  const rows = await db.select().from(orders).where(and(...conds)).orderBy(desc(orders.created_at)).limit(limit);
  const last = rows[rows.length - 1];
  const next_cursor = rows.length === limit && last ? { created_at: last.created_at, id: last.id } : null;
  return { items: rows, next_cursor };
}
