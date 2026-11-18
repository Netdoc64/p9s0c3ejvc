# M12 — Learnings

### What happened
`outbox_events` + `webhook_subscriptions` + `webhook_deliveries`-Schema, `services/outbox.ts` mit `emit()` (insert + Queue-Push) und `deliverEvent()` (HMAC-Sig + 6-Step-Backoff [1s,10s,1m,10m,1h,6h]). Queue-Consumer `src/workers/queue-handler.ts` exportiert als `queue` Worker-Hook. Cron `outbox-sweep` (jede Minute) schiebt liegen gebliebene/retrying Events nach. REST `/v1/webhooks` (POST/GET/DELETE).

### Decisions
1. **Outbox-Tx-Sicherheit**: emit() schreibt INSERT in selbe DB-Tx wie State-Change WENN emit() innerhalb einer Tx aufgerufen wird. v1: kein expliziter Tx-Wrapper im Orchestrator, akzeptiert selten-Fall „state geändert, event nicht inserted" — Sweeper holt es nicht weil kein Eintrag. Plan-Revision-Kandidat: ordersRepo.update + outbox.emit in einer Drizzle-Tx. Aktuell: emit nach update; bei Crash zwischen den beiden geht das Event verloren (low-prob).
2. **Backoff-Sequenz hard-coded** in der Service-Datei (nicht in DB). Plan-Revision-Kandidat falls per-Tenant tunable.
3. **Header-Set** wie Spec: `X-Grosshandel-Event/Signature/Idempotency-Key/Delivery-Attempt/Event-Version`.
4. **`AbortSignal.timeout(10s)`** für Receiver-Calls — spec sagt nicht explizit, ist aber Best-Practice.

### Follow-ups
- M16 Rotation kann nun `secret.rotated.v1` emitten (Plan-Revision).

## 2026-11-18 — Zustellung mit Test belegt (outbox-delivery-test)
- tests/services/outbox-delivery.spec.ts prueft Outbox -> Queue -> Zustellung: HMAC-Header, Retry/Backoff, dead_letter, topic_filter, ungueltige URL, HARD_FAIL_CODES.
- Fund: Backoff war um einen Versuch verschoben (`BACKOFF_SEC[attempt]` statt `[attempt - 1]`): der erste Retry wartete 10 s statt 1 s, die 1-s-Stufe blieb ungenutzt. Behoben in src/services/outbox.ts.
