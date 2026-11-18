import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";

interface Owner {
  tenant_id: string;
  customer_id: string;
}

export interface CheckoutOperation {
  order_id: string;
  kind: "draft" | "confirm" | "cancel";
  request_hash: string;
  idempotency_key: string;
  response_json: string | null;
}

function scope(owner: Owner, id: string) {
  return [owner.tenant_id, owner.customer_id, id];
}

/** Ist der Auftrag in dem Zustand, den der Vorgang herbeiführen sollte? */
export function isSettled(kind: CheckoutOperation["kind"], state: string | null | undefined): boolean {
  if (!state) return false;
  if (kind === "draft") return !["draft", "resolving"].includes(state);
  if (kind === "confirm") return ["confirmed", "shipped", "invoiced", "paid"].includes(state);
  return state === "cancelled";
}

/**
 * Offene Vorgänge des Kunden abschließen, deren Auftrag inzwischen im Zielzustand ist
 * (Antwort ging verloren, bevor `response_json` geschrieben wurde). Läuft auf dem
 * SCHREIBWEG vor jedem neuen Claim — ein offener Claim sperrt über die Partial-Unique-
 * Indizes sonst den nächsten Vorgang. `GET /order-operations/:id` liest nur.
 */
export async function settlePending(env: Env, owner: Owner, build: (order_id: string) => Promise<unknown>): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT o.operation_id, o.kind, o.order_id, r.state_current, r.customer_id AS order_customer
    FROM customer_order_operations o LEFT JOIN orders r ON r.tenant_id = o.tenant_id AND r.id = o.order_id
    WHERE o.tenant_id = ? AND o.customer_id = ? AND o.response_json IS NULL`)
    .bind(owner.tenant_id, owner.customer_id)
    .all<{ operation_id: string; kind: CheckoutOperation["kind"]; order_id: string; state_current: string | null; order_customer: string | null }>();
  let settled = 0;
  for (const row of results) {
    if (row.order_customer !== owner.customer_id || !isSettled(row.kind, row.state_current)) continue;
    const value = await build(row.order_id);
    const r = await env.DB.prepare(`UPDATE customer_order_operations SET response_json = ?
      WHERE tenant_id = ? AND customer_id = ? AND operation_id = ? AND response_json IS NULL`)
      .bind(JSON.stringify(value), ...scope(owner, row.operation_id)).run();
    settled += r.meta.changes ?? 0;
  }
  return settled;
}

export function readOperation(env: Env, owner: Owner, id: string) {
  return env.DB.prepare(`SELECT order_id, kind, request_hash, idempotency_key, response_json FROM customer_order_operations
    WHERE tenant_id = ? AND customer_id = ? AND operation_id = ?`).bind(...scope(owner, id)).first<CheckoutOperation>();
}

export async function runOperation<T>(
  env: Env, owner: Owner, id: string, key: string,
  operation: Pick<CheckoutOperation, "order_id" | "kind">, payload: unknown, execute: () => Promise<T>,
): Promise<T> {
  const hash = await sha256Hex(JSON.stringify([operation.kind, payload]));
  const claim = await env.DB.prepare(`INSERT INTO customer_order_operations
    (tenant_id, customer_id, operation_id, idempotency_key, order_id, kind, request_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(...scope(owner, id), key, operation.order_id, operation.kind, hash, new Date().toISOString()).run();

  if (!claim.meta.changes) {
    const existing = await readOperation(env, owner, id);
    if (existing?.request_hash === hash && existing.idempotency_key === key && existing.response_json) return JSON.parse(existing.response_json) as T;
    throw new CodedError("GH-IDEMP-001");
  }

  let value: T;
  try {
    value = await execute();
  } catch (err) {
    // Ein Fehler darf den Claim nicht offen stehen lassen: die Partial-Unique-
    // Indizes würden sonst jeden weiteren Vorgang des Kunden (Entwurf) bzw. der
    // Bestellung (Bestätigen/Storno) dauerhaft mit GH-IDEMP-001 sperren.
    // Ausnahme: ein Entwurf, der trotz Fehler schon angelegt wurde — den löst
    // GET /order-operations/:id auf, ein zweiter Auftrag entstünde sonst.
    const created = operation.kind === "draft" && await env.DB.prepare(
      "SELECT 1 FROM orders WHERE tenant_id = ? AND id = ?",
    ).bind(owner.tenant_id, operation.order_id).first();
    if (!created) {
      await env.DB.prepare(`DELETE FROM customer_order_operations
        WHERE tenant_id = ? AND customer_id = ? AND operation_id = ? AND response_json IS NULL`)
        .bind(...scope(owner, id)).run();
    }
    throw err;
  }
  await env.DB.prepare(`UPDATE customer_order_operations SET response_json = ?
    WHERE tenant_id = ? AND customer_id = ? AND operation_id = ?`)
    .bind(JSON.stringify(value), ...scope(owner, id)).run();
  return value;
}
