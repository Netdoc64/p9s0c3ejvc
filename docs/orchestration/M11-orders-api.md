---
module_id: M11_orders_api
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P3_orders
---

# M11 — Orders REST API

## Goal

HTTP-Adapter über den Orchestrator. Kunden / Frontend / MCP nutzen ausschliesslich
diese Endpoints, niemals den Orchestrator direkt.

## Non-Goals

- Keine Bulk-Endpoints in v1 (POST /orders/batch — später, wenn nötig)
- Keine GraphQL-Variante

## Success Criteria

Wie Build-Plan `M11_orders_api.acceptance[]`. Zusätzlich:

- E2E-Test: Pilot-Tenant + Floraly + 10 Karton Rosen → 200, Doc zurück mit
  State `awaiting_confirmation`, dann confirm → `confirmed`
- Cancel released Stock-Reservation
- Cross-Tenant-Read → 404 (`GH-TENANT-001`)
- Alle Endpoints in OpenAPI registriert

## Execution Intent (Vibe)

- Endpoints sind dünn: Input parsen, Tenant aus c.var, Orchestrator rufen,
  Output mappen
- Keine Business-Logik im Route-Handler
- Pagination: cursor-based, kein Offset

## Inputs Required

- M10 fertig
- M02 (Auth, Idempotency, Error-Mapping)

## Deliverables

```
src/routes/orders.ts                   POST/GET/Confirm/Cancel
src/routes/orders.openapi.ts           Zod+OpenAPI-Annotations
tests/routes/orders.spec.ts            inkl. Cross-Tenant
tests/e2e/order-happy-path.spec.ts     full E2E
```

## Happy Path

**Create-Draft:**
1. `POST /v1/orders` mit `{customer_id, lines: [{sku_id, qty}], requested_delivery_date?, notes?}` und Idempotency-Key.
2. M02-Pipeline. Zod-Parse.
3. Customer-Snapshot via `customers.findById(customer_id)` (tenant-scoped, 404 sonst).
4. Build Initial-Doc: `id="ord_"+ulid()`, `state.current="draft"`, `plan.next_steps = [resolve, validate_gates, reserve_stock, await_confirmation]`.
5. `repos.orders.create(initial_doc)`.
6. `orchestrator.runNextStep(doc)` → Auto-Chain durch `resolve` (Pricing+Tax), `validate_gates` (credit/min-order/vat), `reserve_stock` (per Line DO-Reserve). Stoppt bei `await_confirmation`.
7. Doc-State jetzt `awaiting_confirmation` (oder `on_hold` bei Gate-Failure).
8. Response 201 mit Order-Doc (visibility-gefiltert via `_visibility`).

**Confirm:**
9. `POST /v1/orders/:id/confirm` mit Idempotency-Key.
10. `repos.orders.findById(id)` (404 cross-tenant). State-Check `current === "awaiting_confirmation"` sonst `GH-STATE-001`.
11. Doc-Plan injizieren: `next_steps = [commit_stock, state_transition→confirmed, emit_event(order.confirmed.v1), generate_invoice]`.
12. `orchestrator.runNextStep` chained internal → bricht bei `emit_event` (external).
13. State `confirmed`, Stock committed. Response 200 mit Doc.

**Cancel:**
14. `POST /v1/orders/:id/cancel` mit `{reason}`.
15. State-Check (nur aus `awaiting_confirmation` oder `confirmed` vor `shipped`). Inject `next_steps = [release_stock, state_transition→cancelled, emit_event(order.cancelled.v1)]`. Run.

**Read/List:**
16. `GET /v1/orders/:id` → Doc.
17. `GET /v1/orders?state=confirmed&customer_id=cust_x&created_after=...&cursor=...&limit=50` → Cursor-Pagination, opaque base64(`{created_at, id}`), tenant-scoped.

## Error Paths

| Symptom                                 | Code            | Recovery |
|-----------------------------------------|-----------------|----------|
| Order-ID nicht in Tenant                | `GH-TENANT-001` | 404 (no leak) |
| Confirm in falschem State               | `GH-STATE-001`  | 409 |
| Cancel in finalem State                 | `GH-STATE-001`  | 409 |
| Idempotency-Key bekannt, anderer Body   | `GH-IDEMP-001`  | aus M02 |

## Fallbacks

- Orchestrator-Step crashed → Endpoint gibt 503 mit Retry-After zurück; Client
  wiederholt mit gleichem Idempotency-Key

## Backwards-Compat Implications

- API-Pfade `/v1/orders` permanent
- Response-Schema folgt Order-Document-Schema (alle Compat-Regeln gelten)

## Open Questions

- [x] ~~Filter-Set v1?~~ → **`state`, `customer_id`, `created_after`,
  `created_before`** (2026-04-28). Erweiterung additiv ohne Breaking.
- [x] ~~Pagination-Cursor-Format?~~ → **Opaque (Base64 von `(created_at, id)`)**
  (2026-04-28). Reason: kein Lock-in auf interne Sortier-Logik; Migration
  möglich ohne Client-Anpassung.

## Observability

- Endpoint-Latenz pro Route
- Order-Erstellungs-Rate pro Tenant
- 4xx/5xx-Rate

## Test Strategy

- Per-Endpoint Unit
- E2E mit Pilot-Seed (M14)
- Cross-Tenant für jeden Endpoint
- Idempotenz für POST /orders und POST /orders/:id/confirm

## Learnings

→ `learnings/M11-orders-api.log.md`

## Plan Revisions Originating Here

(initial leer)
