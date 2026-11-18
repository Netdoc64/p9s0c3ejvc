---
module_id: M10_orchestrator
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P3_orders
---

# M10 — Order Orchestrator (Stateless Step-Runner)

## Goal

`runNextStep(doc) → doc`: liest das Order-Document, evaluiert Gates, findet den
nächsten erlaubten Step in `plan.next_steps[]`, führt aus, schreibt zurück. Idempotent
pro `(doc.id, step.id)`.

## Non-Goals

- Kein Workflow-DSL — Steps sind hartcodierte Handler
- Keine Auto-Chain (siehe Open Question)
- Kein Cron / Scheduler — Orchestrator läuft auf API-Trigger oder Queue-Message

## Success Criteria

Wie Build-Plan `M10_orchestrator.acceptance[]`. Zusätzlich:

- Doppelter Aufruf desselben Step → genau einmal echte Wirkung (Idempotenz)
- Gate-Failure setzt State `on_hold`, blocking-Issue mit Code

## Execution Intent (Vibe)

- Step-Handler sind Klein-Funktionen, jeder kapselt eine konkrete Action
- Handler-Registry: `Record<StepType, Handler>`, einfach erweiterbar
- Gates sind eigene Datei (`gates.ts`), Handler ist eigene Datei
- Keine Implicit-State-Mutationen — jeder Step gibt explizit das nächste Doc zurück

## Inputs Required

- M06, M07, M08, M09 fertig
- Antwort auf Auto-Chain-Frage

## Deliverables

```
src/orchestrator/index.ts              runNextStep
src/orchestrator/gates.ts              evaluateGates
src/orchestrator/state-machine.ts      allowed-transitions
src/orchestrator/handlers/
  resolve.ts        SKU/Pricing/Tax-Resolution
  reserve_stock.ts  via M08 DO
  validate_gates.ts
  await_confirmation.ts
  commit_stock.ts
  emit_event.ts     für M12 Outbox
tests/orchestrator/*.spec.ts
```

## Happy Path

1. Caller (M11 oder Queue-Consumer) ruft `orchestrator.runNextStep(doc)`.
2. State-Machine-Check: `state-machine.canTransition(doc.state.current, expected_after_step)`. Wenn nein → `GH-STATE-001` 409.
3. `next = doc.plan.next_steps[0]` ziehen. Wenn `null` → return Doc unverändert (terminal).
4. Idempotenz-Check: wenn `step.id` bereits in `doc.plan.executed_steps[]` → skip step, append `next_steps` shift, recurse.
5. Handler aus Registry: `handlers[step.type]`. Wenn fehlt → `GH-INFRA-002`.
6. `result = await handler.execute(doc, step, env, ctx)`.
7. Bei Success: `new_doc = handler.applyResult(doc, result)`. `executed_steps.push({step_id, type, started_at, ended_at, decision_reason, result_summary})`. `next_steps.shift()`. State ggf. weitergesetzt (`history.push({from, to, by_step_id, ts})`).
8. Bei Gate-Failure: State → `on_hold`, `issues.blocking.push({code, detail, gate_id})`, kein further chain.
9. Bei Step-Throw: Code propagiert, Save findet nicht statt, Doc-Etag bleibt — Retry ist möglich.
10. **Auto-Chain-Entscheidung:**
    - `step.type ∈ {resolve, validate_gates, reserve_stock, commit_stock, state_transition, audit_append}` → recurse `runNextStep(new_doc)`.
    - `step.type ∈ {emit_event, queue_message, webhook, external_call, user_interaction, await_confirmation}` → break, return new_doc.
11. Save via `repos.orders.update(id, original_etag, () => new_doc)`.
12. Return new_doc.

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Gate failure                         | `GH-ORDER-003`   | State → `on_hold`, blocking-Issue |
| Illegale State-Transition            | `GH-STATE-001`   | 409 |
| Step-Handler wirft Sub-Code (z.B. Stock) | weitergereicht | Doc landet on_hold mit dem Sub-Code im issues[] |

## Fallbacks

- Step-Handler crashed mid-execution → Doc-Etag bleibt unverändert (Save fand nicht
  statt) → Retry möglich. Idempotenz schützt vor Doppelausführung des bereits
  durchgelaufenen Teils.

## Backwards-Compat Implications

- Step-`type`-Werte (`internal`, `external_call`, `queue_message`, `notification`,
  `webhook`, `user_interaction`) permanent
- Step-`id`-Konventionen: alphanumerisch + Underscore, niemals umbenennen
- `executed_steps[]`-Schema: append-only

## Open Questions

- [x] ~~Auto-Chain?~~ → **Hybrid** (2026-04-28):
  - **Internal-Steps** (resolve, validate_gates, reserve_stock, commit_stock,
    state-transitions) chainen automatisch solange erfolgreich
  - **External-Calls** (queue_message, webhook, external_call) BREAK die Chain
    — explicit retrigger via Queue-Consumer oder API-Call
  - **User-Interactions** (`type: "user_interaction"`) brechen sowieso
  - Reason: schnelle Innen-Pfade ohne Roundtrip-Latenz, äussere I/O bleibt
    entkoppelt, retryable, observabel.

## Observability

- Step-Dauer pro Handler-Typ
- Step-Failure-Rate
- Doc im State `on_hold` (Gauge — wenn hoch, ist was kaputt)

## Test Strategy

- Handler-Unit-Tests
- End-to-End-Test mit Fake-DO/-Engines
- Idempotenz-Test (Step zweimal aufrufen)
- Crash-Recovery-Test (Mock Save-Fehler)

## Learnings

→ `learnings/M10-orchestrator.log.md`

## Plan Revisions Originating Here

(initial leer)
