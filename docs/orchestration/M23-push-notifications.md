---
module_id: M23_push_notifications
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P4_eventing_and_clients
---

# M23 — Push Notifications (Mobile)

## Goal

Order-Status-Events erreichen den Endkunden zeitnah auf seinem Mobile-Gerät —
APNs (iOS) und FCM (Android), pro Customer mehrere Devices möglich.

## Non-Goals

- Kein In-App-Messaging-Center (separate UI-Verantwortung der Mobile-App)
- Kein Email-Push v1 (Email läuft über M22-Notification-Pfad, separat)
- Kein SMS-Push v1

## Success Criteria

- Customer registriert Device (`POST /v1/devices` mit `platform`, `push_token`)
- Bei Order-State-Change → Push an alle aktiven Devices des Customers innerhalb
  10s p99
- Invalides Device-Token (APNs/FCM 410/404) wird auto-cleanup-markiert
- Tenant-Branding: Title + Icon + Sound konfigurierbar pro Tenant

## Execution Intent (Vibe)

- **Adapter-Pattern:** APNs- + FCM-Adapter implementieren `PushSender`-Interface.
  Kein Multi-Provider-Lock-in.
- **Webhook-Subscriber-Pattern:** M23 ist ein interner Subscriber auf M12-Events.
  Selbst kein Polling.
- **Throttling pro Customer:** max 5 Pushes/min/Customer, sonst gebatcht.
- **Quiet Hours pro Customer-Zeitzone:** kein Non-Urgent-Push 22:00–07:00 lokal.

## Inputs Required

- M12 (Outbox + Webhooks-Eventing)
- M02b (Customer-Auth — Device-Registration ist customer-authenticated)
- Cross-Cutting `time_zones` (für Quiet Hours)

## Deliverables

```
migrations/00XX_devices.sql            devices (customer_id, platform, push_token, last_seen_at, invalid_at)
src/services/push/
  apns.ts                              APNs-HTTP/2-Adapter (Bearer-Token-Auth)
  fcm.ts                               FCM-Adapter
  registry.ts                          PushSender-Registry
  throttler.ts                         Per-Customer-Rate
  quiet-hours.ts                       lokale Zeit-Logik
src/routes/devices.ts                  POST/DELETE /devices
src/workers/push-deliverer.ts          Queue-Consumer für Push-Events
src/services/event-subscribers/push.ts mappt Order-Events auf Push-Payloads
tests/...
```

## Happy Path (Order Confirmed)

1. M12 emittiert `order.confirmed.v1`-Event in Queue
2. Push-Subscriber konsumiert
3. Lookup: Customer-ID → aktive Devices
4. Throttle-Check, Quiet-Hours-Check (falls non-urgent)
5. Pro Device: Adapter (APNs/FCM) sendet
6. Erfolg: `devices.last_seen_at = now`. 410/404: `devices.invalid_at = now`,
   Cleanup-Cron entfernt nach 30d.

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| APNs/FCM Provider unerreichbar       | `GH-PUSH-001`    | Queue-Retry exponential |
| Device-Token invalid                 | `GH-PUSH-002`    | Markiert, kein Retry |
| Customer hat keine Devices           | (kein Fehler)    | nichts tun, Log-Warn |
| Throttle/Quiet-Hours blockiert       | (kein Fehler)    | gebatcht oder verworfen je nach Urgency-Tag |

## Fallbacks

- Wenn beide Provider tot: Push wird in Queue gehalten, Retry mit
  Backoff. Nach 24h Dead-Letter mit Tenant-Notification (Operator wird informiert).
- Customer ohne Devices: ggf. Email als Fallback (M22-Notification, separat).

## Backwards-Compat Implications

- Device-Token-Format opaque, nicht inspizierbar
- Push-Payload-Schema versionsiert (`v` field): alte App-Versionen erhalten v1
  auch wenn Server v2 versteht
- Event-Mapping append-only

## Open Questions

- [x] ~~APNs/FCM-Direkt oder Provider (OneSignal/Pusher)?~~ → **Direkt
  (APNs HTTP/2 + FCM v1 API)** (2026-04-28). Reason: Kontrolle, keine
  monatlichen Kosten skaliert mit DAU; CF-Worker können HTTP/2 client-side.
- [x] ~~Quiet-Hours-Default?~~ → **22:00–07:00 lokal, Customer überschreibbar**
  (2026-04-28). Reason: B2B-Florist arbeitet früh, aber 22-7 ist Konsens.

## Observability

- `push.delivery.success/failed` pro Provider
- `push.device.invalid_rate` (zu hoch = Token-Lifecycle-Problem)
- `push.queue.lag_seconds`

## Test Strategy

- Mock-APNs-/FCM-Server für Roundtrip-Tests
- Token-Cleanup nach 410-Antwort
- Throttle-Test: 10 Events in 1min, max 5 Pushes
- Quiet-Hours-Boundary-Test (22:00:00 lokal blockt, 21:59:00 nicht)

## Learnings

→ `learnings/M23-push-notifications.log.md`

## Plan Revisions Originating Here

(initial leer)
