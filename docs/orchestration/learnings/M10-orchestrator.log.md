# M10 — Learnings

### What happened
`runNextStep(env, tenant_id, order_id)` führt `plan.next_steps[0]` aus, Auto-Chain für Internal-Steps (resolve, validate_gates, reserve_stock, commit_stock, release_stock, state_transition, audit_append), bricht bei External/User (emit_event, await_confirmation, generate_invoice, queue_message, webhook, external_call, user_interaction). Persistierung mit Compare-and-Swap pro Step. Handler in `src/orchestrator/handlers.ts`. Gates-Auswertung pure in `gates.ts`. Outbox-Hook über Lazy-Import damit M12 nachgereicht werden kann.

### Decisions
1. **Save pro Step** statt erst am Ende — bei Crash ist mindestens der letzte Step persistent. Trade-off: mehr D1-Writes; akzeptabel für v1.
2. **Idempotenz pro `step.id`**: `next_steps.shift()` und `executed_steps.push(...)` in derselben Transaktion; doppelte Ausführung des gleichen step.id → no-op.
3. **Hybrid Auto-Chain**: nur Internal-Steps chainen; jeder External/User-Step bricht aus damit Aufrufer (Queue-Consumer, Confirm-Endpoint) explizit anstösst.
4. **`MAX_AUTO_CHAIN_STEPS=20`** als Sicherheitsnetz gegen Endlos-Chains.

## 2026-11-17 — erster Lauf gegen echtes Cloudflare (Staging)

### What happened
Der Smoke-Test lief erstmals gegen D1/DO/Queue statt gegen Attrappen. Zwei Fehler, die kein Unit-Test sehen konnte:

1. **`emit_event` schrieb nie ein Event.** Der Handler rief `outbox.emit()` ohne `env`; das wirft seit #C-003, und ein leeres `catch {}` schluckte es. Der Schritt stand trotzdem als ausgeführt im Plan.
2. **Die Bestätigung endete nach dem Event.** `emit_event` und `generate_invoice` galten als „extern“ und brachen die Auto-Chain — und nichts sonst ruft `runNextStep` fort. Keine bestätigte Bestellung bekam je eine Rechnung.

### Plan-Revision (Decision 3 oben)
- `emit_event` legt das Event in `external_refs._pending_emits` ab (wie der Kopf von `orchestrator/index.ts` es beschreibt); `ordersRepo.update` fügt es im selben D1-Batch ein.
- `emit_event` und `generate_invoice` sind **interne** Schritte: das Event ist durch die Outbox nur ein Insert (zugestellt wird über die Queue), die Rechnung läuft serverseitig ohne Nutzer. „Extern“ bleibt, was wirklich auf jemanden wartet (`await_confirmation`, `user_interaction`, …).
- `tests/orchestrator/steps.spec.ts` hält beides; der Smoke prüft die Rechnungsnummer nach dem Confirm.

## 2026-11-17 — zu wenig Bestand

`reserve_stock` warf bei FEFO-/Bestandsmangel mitten in der Kette: 422 an den Client, das Dokument blieb trotzdem als `resolving` gespeichert, Reservierungen früherer Zeilen hingen bis zum TTL (2 h). Jetzt zweiphasig: erst FEFO für alle Zeilen, dann reservieren; Mangel → `on_hold` mit `issues.blocking` (GH-FEFO-001 / GH-STOCK-001), bereits Reserviertes wird freigegeben, Antwort 201 — wie bei Gate-Fehlern (M10-Akzeptanz). Der Smoke prüft den Fall.
