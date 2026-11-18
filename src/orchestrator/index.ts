import type { Env } from "../env";
import type { OrderDoc } from "../schemas/order";
import * as ordersRepo from "../repos/orders";
import { HANDLERS } from "./handlers";
import { isInternalStep } from "./state-machine";

const MAX_AUTO_CHAIN_STEPS = 20;

/**
 * Stateless Step-Runner. Reads doc, evaluiert plan.next_steps, führt aus,
 * persistiert. Auto-Chain für Internal-Steps; bricht bei External/User-Interaction.
 *
 * Outbox-Tx (M12 hardening): emit_event-Handler legen Events in
 * `doc.external_refs._pending_emits` ab; ordersRepo.update inserted sie
 * atomar im selben D1-Batch wie das UPDATE. Nach Save: Queue-Push für
 * sofortige Delivery (best-effort; Sweeper holt nach).
 */
export async function runNextStep(env: Env, tenant_id: string, order_id: string, max_steps = MAX_AUTO_CHAIN_STEPS): Promise<{ doc: OrderDoc; etag: string; steps_executed: number }> {
  const db = (await import("../db/client")).getDb(env.DB);

  let chained = 0;
  let result = await ordersRepo.requireById(db, tenant_id, order_id);
  let doc = result.doc;
  let etag = result.etag;

  while (chained < max_steps) {
    const next = doc.plan.next_steps[0];
    if (!next) break;

    const handler = HANDLERS[next.type];
    if (!handler) break;

    const now = new Date().toISOString();
    const handlerResult = await handler(doc, { env, step: next, now });
    const newDoc = handlerResult.doc;

    // Persist atomar mit Outbox-Inserts (siehe ordersRepo.update)
    const updated = await ordersRepo.update(db, tenant_id, order_id, etag, () => newDoc);
    doc = updated.doc;
    etag = updated.etag;
    chained += 1;

    // Post-commit-Queue-Push (best-effort). Sweeper-Cron holt zurückgebliebene Events.
    for (const event_id of updated.emitted_event_ids) {
      try { await env.OUTBOX_QUEUE.send({ event_id }); } catch { /* sweeper picks up */ }
    }

    if (handlerResult.blocked) break;
    if (!isInternalStep(next.type)) break;
  }

  return { doc, etag, steps_executed: chained };
}
