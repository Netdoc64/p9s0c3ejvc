import { canTransition, type OrderState } from "../schemas/order";

export { canTransition };

export const INTERNAL_STEPS = new Set([
  "resolve",
  "validate_gates",
  "reserve_stock",
  "commit_stock",
  "release_stock",
  "state_transition",
  "audit_append",
  // Seit 2026-11-17 intern: emit_event ist durch die Outbox nur ein Insert im
  // selben D1-Batch (zugestellt wird über die Queue), und generate_invoice
  // läuft serverseitig ohne Nutzer. Als „extern“ brach die Kette nach dem
  // Event ab — und weil nichts sonst runNextStep fortsetzt, bekam KEINE
  // bestätigte Bestellung je eine Rechnung. Plan-Revision in
  // docs/orchestration/learnings/M10-orchestrator.log.md.
  "emit_event",
  "generate_invoice",
]);

export const EXTERNAL_OR_USER_STEPS = new Set([
  "queue_message",
  "webhook",
  "external_call",
  "user_interaction",
  "await_confirmation",
]);

export function isInternalStep(type: string): boolean {
  return INTERNAL_STEPS.has(type);
}

export type { OrderState };
