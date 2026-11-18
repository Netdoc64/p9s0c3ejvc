import type { Env, OutboxMessage } from "../env";
import { deliverEvent } from "../services/outbox";
import { isCodedError } from "../errors/catalog";

/**
 * Hard-Fail-Codes: Errors die ein Retry NICHT lösen (kein Receiver, malformed event,
 * tenant deleted). Diese Messages werden ack'd statt retried — verhindert DLQ-Spam
 * durch poison messages (#C-008).
 */
const HARD_FAIL_CODES = new Set([
  "GH-INPUT-001",  // event payload broken
  "GH-TENANT-001", // tenant gone
]);

/**
 * Queue-Consumer: liefert Outbox-Events an Webhook-Subscribers.
 */
export async function queueHandler(batch: MessageBatch<OutboxMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      if (msg.body?.event_id) {
        await deliverEvent(env, msg.body.event_id);
      }
      msg.ack();
    } catch (err) {
      const code = isCodedError(err) ? err.code : undefined;
      const hardFail = code && HARD_FAIL_CODES.has(code);
      console.error(JSON.stringify({
        event: hardFail ? "queue.hard_fail" : "queue.error",
        code,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (hardFail) {
        msg.ack(); // unrecoverable — ack to avoid retry storm
      } else {
        msg.retry();
      }
    }
  }
}
