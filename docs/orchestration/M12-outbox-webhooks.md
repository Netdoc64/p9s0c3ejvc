---
module_id: M12_outbox_webhooks
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P4_eventing_and_clients
---

# M12 — Outbox + Webhooks

## Goal

State-Übergänge emittieren Events transactional in eine Outbox-Tabelle, ein
Queue-Worker liefert sie an Tenant-konfigurierte Webhook-URLs mit HMAC-Sig +
Retry mit Exponential-Backoff.

## Non-Goals

- Keine Event-Streaming-Infrastruktur (Kafka etc.) — CF Queues reichen
- Keine garantiert-geordnete Zustellung pro Order (Topics ggf., aber kein FIFO-
  Versprechen über Queue-Boundaries)

## Success Criteria

Wie Build-Plan `M12_outbox_webhooks.acceptance[]`. Zusätzlich:

- order.confirmed bei 2 Subs → 2 Deliveries, beide mit gültiger HMAC
- 5xx vom Receiver → Retry kommt nach Backoff
- 6 Versuche, dann Dead-Letter
- Idempotency-Key im Header, damit Receiver dedupen kann

## Execution Intent (Vibe)

- **Outbox-Pattern strikt**: Event-Insert in selbe DB-Transaktion wie State-Change.
  Trigger pusht in Queue. Wenn Trigger crasht, holt der Cron-Sweeper auf.
- Backoff: 1s, 10s, 1m, 10m, 1h, 6h
- Receiver-Side-Header: `X-Grosshandel-Event`, `X-Grosshandel-Signature`,
  `X-Grosshandel-Idempotency-Key`, `X-Grosshandel-Delivery-Attempt`

## Inputs Required

- M11 fertig (State-Changes finden statt)
- Antwort auf Event-Versionierungs-Frage

## Deliverables

```
migrations/00XX_webhooks.sql           webhook_subscriptions, outbox_events, webhook_deliveries
src/services/outbox.ts                 Insert in Tx, Trigger-to-Queue
src/workers/webhook-deliverer.ts       Queue-Consumer
src/routes/webhooks.ts                 CRUD für Subscriptions
tests/...
```

## Happy Path

**Emit (in derselben Tx wie State-Change):**
1. M10/M11 ruft `outbox.emit({tenant_id, topic: "order.confirmed.v1", aggregate_id: order_id, payload})` innerhalb der bestehenden D1-Tx.
2. `INSERT INTO outbox_events (id="evt_"+ulid(), tenant_id, topic, aggregate_id, payload=JSON, status="pending", created_at, attempt=0)`.
3. Tx commit.
4. Post-Commit-Hook (`ctx.waitUntil`): `env.OUTBOX_QUEUE.send({event_id})`.

**Deliver (Queue-Consumer-Worker):**
5. `queue(batch)`-Handler nimmt Messages.
6. Pro Message: `SELECT FROM outbox_events WHERE id=? AND status IN ('pending','retrying')`. Wenn schon `delivered` → ack, skip.
7. `SELECT FROM webhook_subscriptions WHERE tenant_id=? AND (topic_filter='*' OR topic_filter=event.topic) AND active=true`.
8. Pro Subscription: build Body `{event_id, topic, occurred_at, tenant_id, payload}`. HMAC `signature = HMAC-SHA256(sub.signing_secret, body)`. Headers `X-Grosshandel-Event`, `X-Grosshandel-Signature`, `X-Grosshandel-Idempotency-Key=event_id`, `X-Grosshandel-Delivery-Attempt=n`, `X-Grosshandel-Event-Version=v1`.
9. `fetch(sub.url, {method: 'POST', headers, body, signal: AbortSignal.timeout(10000)})`.
10. 2xx → `INSERT webhook_deliveries (status='delivered', attempt, response_status, latency_ms)`. Mark Event delivered (wenn alle Subs durch).
11. Non-2xx oder Timeout: `attempt+=1`. Wenn `attempt < 6` → status='retrying', `retry_at = now + backoff[attempt]` (1s, 10s, 1m, 10m, 1h, 6h). Schedule via `OUTBOX_QUEUE.send({event_id, sub_id}, {delaySeconds})`. Sonst → status='dead_letter', `GH-WEBH-002`.

**Sweeper (M17-Cron, jede 1min):**
12. `SELECT FROM outbox_events WHERE status='pending' AND created_at < now-30s LIMIT 100` → manuell in Queue nachschieben.

## Error Paths

| Symptom                       | Code             | Recovery |
|-------------------------------|------------------|----------|
| Receiver 5xx                  | `GH-WEBH-001`    | Retry exponential |
| Receiver 4xx (≠ 408/429)      | `GH-WEBH-001`    | Kein Retry, Dead-Letter |
| Max Retries erreicht          | `GH-WEBH-002`    | Dead-Letter, Tenant-Notification |

## Fallbacks

- Queue down → Outbox-Sweeper läuft jede 1min und schiebt nach
- Wenn auch der Sweeper nicht durchkommt: Events bleiben in Outbox, werden bei
  System-Wiederherstellung gepusht (kein Datenverlust)

## Backwards-Compat Implications

- Event-Topic-Namen (`order.confirmed`, `order.cancelled`, …) permanent
- Event-Payload-Schema versionsiert (siehe Open Question)
- Webhook-Header-Set permanent

## Open Questions

- [x] ~~Event-Schema-Versionierung?~~ → **Per-Topic, Major-Version im Topic-Namen**
  (`order.confirmed.v1`) (2026-04-28). Reason: bei Breaking läuft `.v2` parallel
  während Sunset-Periode, beide Subscriber-Generationen funktionieren. Header
  `X-Grosshandel-Event-Version` zusätzlich gesetzt für Convenience-Reader.

## Observability

- Outbox-Lag (Events ältester ungesendeter Event)
- Delivery-Erfolgsrate pro Tenant
- Dead-Letter-Anzahl

## Test Strategy

- Outbox-Tx-Sicherheit (Crash mitten in Tx → kein Event ohne State-Change und
  umgekehrt)
- Backoff-Test (Mock-Receiver mit 5xx, dann 200)
- Cross-Tenant: Tenant-A-Subscription bekommt nur Tenant-A-Events

## Learnings

→ `learnings/M12-outbox-webhooks.log.md`

## Plan Revisions Originating Here

(initial leer)
