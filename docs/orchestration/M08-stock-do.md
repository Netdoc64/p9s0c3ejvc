---
module_id: M08_stock_do
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M08 — Stock Durable Objects

## Goal

Atomare Bestandsführung pro `(tenant, sku)` über ein Durable Object,
mit Soft-Reservierungen + TTL-Ablauf, `commit`/`release`-Semantik und
Audit-Trail in `stock_movements`.

## Non-Goals

- Keine automatische Nachbestellung
- Keine Multi-Lager-Optimierung in v1 (siehe Open Questions)
- Keine Inventur-UI (separates Modul später)

## Success Criteria

Wie Build-Plan `M08_stock_do.acceptance[]`. Zusätzlich:

- 100 parallele `reserve(1)` auf Bestand 50 → genau 50 erfolgreich, 50 ×
  `GH-STOCK-001`
- TTL-Ablauf releast automatisch innerhalb ≤ 30s nach Ablaufzeit
- `stock_movements` enthält Eintrag für jede Mutation mit `reason`

## Execution Intent (Vibe)

- DO ist single-writer per Definition — nutze das, keine zusätzlichen Locks
- DO-State minimal halten: `available`, `reservations: Map<id, {qty, expires_at}>`,
  `last_committed_movement_id`
- Alarm-API für TTL-Cleanup
- D1-Tabelle `stock_movements` als Append-Only-Audit, DO schreibt asynchron
  via Outbox-Muster (siehe M12)

## Inputs Required

- M05 fertig (SKU existiert)
- M01-Skeleton mit DO-Binding `STOCK_DO`
- Antworten auf Open Questions

## Deliverables

```
src/do/stock.ts                        DurableObject-Klasse
src/services/stock.ts                  Wrapper für DO-Aufrufe (id-routing)
migrations/00XX_stock.sql              warehouses, stock_movements
src/routes/stock.ts                    POST /stock/movements (manuelle Anpassungen)
tests/do/stock.spec.ts                 Unit (Logik im DO)
tests/integration/stock-stress.spec.ts Concurrent-Reservierung
```

## Happy Path

**Routing:**
1. Caller (Orchestrator, M10) ruft `services.stock.reserve(tenant_id, warehouse_id, sku_id, qty, ttl_sec)`.
2. Service bildet DO-Name `${tenant_id}/${warehouse_id}/${sku_id}`, holt DO via `env.STOCK_DO.idFromName(...)`.

**Reserve im DO:**
3. DO.fetch(`POST /reserve {qty, ttl_sec, idempotency_key}`).
4. DO lädt internen State (`storage.get` für `available`, `reservations`).
5. Idempotenz-Check: wenn `idempotency_key` bereits in `reservations` → return existierende `reservation_id`.
6. Sum aller aktiven (non-expired) Reservations berechnen. Wenn `available - sum_reservations < qty` → return 409 `GH-STOCK-001`.
7. `reservation_id = "res_" + ulid()`. Speichere `reservations[reservation_id] = {qty, expires_at: now + ttl_sec, idempotency_key}`. `storage.setAlarm(min over all expires_at)` für TTL-Cleanup.
8. Schreib-Outbox in DO-Storage: `pending_movements[]` mit `{type: "reserve", reservation_id, qty, ts}`. Service flushed nach DO-Response in `stock_movements`-Tabelle (asynchron, retryable).
9. Return 200 `{reservation_id, expires_at}`.

**Commit:**
10. `commit(reservation_id)`: DO lookup, wenn nicht vorhanden → `GH-STOCK-002`. `available -= qty`, `delete reservations[reservation_id]`. Append `pending_movements`.

**Release:**
11. `release(reservation_id)`: DO lookup, idempotent. `delete reservations[reservation_id]`. Append `pending_movements`.

**Alarm:**
12. `alarm()` (CF-DO-Alarm-API): iteriere `reservations`, lösche alle mit `expires_at <= now`, `pending_movements` += `{type: "auto_release", ...}`. Re-set Alarm auf next-min `expires_at`.

**Manuelle Anpassung:**
13. `POST /v1/stock/movements` mit `{warehouse_id, sku_id, qty_delta, reason}` → routed an DO `adjust(qty_delta, reason)`.

## Error Paths

| Symptom                           | Code             | Recovery |
|-----------------------------------|------------------|----------|
| Bestand zu niedrig                | `GH-STOCK-001`   | 409 |
| Reservation abgelaufen bei Commit | `GH-STOCK-002`   | 410; Order muss erneut reservieren |
| DO nicht erreichbar               | `GH-STOCK-003`   | 503, exponential retry |

## Fallbacks

- DO unerreichbar (selten, regional) → Order-Orchestrator pausiert in `resolving`,
  Retry. Niemals „Bestand fiktiv reserviert" als Fallback.

## Backwards-Compat Implications

- DO-State-Schema (in DO-Storage) muss versionsiert sein — bei Änderung Reader
  beider Versionen mitführen
- `stock_movements`-Tabelle: append-only, niemals löschen
- Reservation-IDs sind permanent (kommen in Order-Documents vor)

## Open Questions

- [x] ~~Multi-Warehouse-Strategie?~~ → **Strikt pro Lager v1** (2026-04-28).
  Reason: einfacheres DO-Modell, klare Boundaries. Lager-Auswahl-Routing (welches
  Lager bedient eine Order) lebt im Order-Orchestrator (M10) via Tenant-Setting
  `warehouse_priority_order: string[]` und `default_warehouse_id`.
- [x] ~~Negativbestand?~~ → **Tenant-Setting `allow_backorder: false` Default,
  SKU-überschreibbar** (2026-04-28). Reason: meiste Blumen-SKUs sind verderblich
  (kein Backorder); einzelne Bestellware (Topfpflanzen) braucht Override.
- [x] ~~DO-Granularität?~~ → **Pro `(tenant, warehouse, sku)`** (2026-04-28).
  Reason: natürliche Boundaries, jedes Lager ist eigene Konsistenz-Insel. Bei
  CF-DO-Kosten und Grössenordnung des Pilots (≤ wenige Lager × tausende SKUs)
  unproblematisch.

## Observability

- DO-Operations-Latenz (reserve, commit, release)
- TTL-Auto-Release-Rate (zu hoch = Reservierungs-TTL zu kurz oder Verlassene Carts)
- `available` als Gauge pro hot-SKU (Alerts bei Schwellenunterschreitung)

## Test Strategy

- Concurrent-Reserve (100, 1000 parallel)
- TTL-Cleanup (alarm-getrieben, schwierig — miniflare Alarm-API)
- Cross-Tenant-Test: Tenant-A-DO ist nicht von Tenant-B reachable
- Idempotenz: Commit derselben `reservation_id` zweimal → einmalig wirksam

## Learnings

→ `learnings/M08-stock-do.log.md`

## Plan Revisions Originating Here

(initial leer)
