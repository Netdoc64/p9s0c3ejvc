---
module_id: M15_rate_limiting
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M15 — Rate-Limiting + Quotas

## Goal

Schutz gegen Abuse und Lastspitzen via per-Tenant + per-Customer + per-Endpoint-Klasse
Rate-Limits. Default-Budgets im Cross-Cutting, Override pro Tenant-Tier.

## Non-Goals

- Keine Bot-Detection (M18-Observability oder CF-WAF-Layer, separat)
- Keine Quota-Abrechnung (Telemetrie ja, Billing-Logik ist Plan-Revision)
- Kein Adaptive-Rate-Limiting v1 (statische Buckets reichen)

## Success Criteria

- Customer der 100 Login-Versuche/min macht → ab 11. Versuch `GH-RATE-001`
- Tenant-Tier-Quota überschritten → `GH-RATE-002` mit Reset-Header
- Hot-Path (`GET /v1/products/search`) hat eigenes Budget, nicht durch Cold-Path
  gestört
- Header `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` auf
  jeder gerouteten Response

## Execution Intent (Vibe)

- **Sliding-Window-Counter in KV** (Worker-nativ, Edge-lokal). Für strikte Cases
  (Login, Magic-Link-Request) zusätzlich DO mit atomarer Counter-Logik.
- **Endpoint-Klassen statt pro Pfad**: `auth_login`, `auth_token_refresh`,
  `read_hot`, `read_warm`, `write_safe`, `write_critical`. Routes labeln sich
  via Hono-Middleware-Annotation.
- **Customer-Limits zusätzlich zu Tenant-Limits** — beide müssen passen.
- **Token-Bucket-Algorithmus** (refill-Rate konfigurierbar), nicht starres Window.

## Inputs Required

- M02 (Middleware-Pipeline)
- M03 (Tenant-Setting `rate_limit_tier`)
- Cross-Cutting `rate_limits` (Default-Buckets — siehe build-plan)

## Deliverables

```
src/middleware/rate-limit.ts          Token-Bucket gegen KV/DO
src/repos/rate-limits.ts              Tier-Konfig pro Tenant
migrations/00XX_rate_limit_tiers.sql  rate_limit_tiers, tenant_rate_overrides
tests/middleware/rate-limit.spec.ts   inkl. Race-Tests
```

## Happy Path

1. Request kommt rein → Middleware liest Endpoint-Klasse-Label
2. Bucket-Key = `(tenant_id, customer_id?, class)` — bei B2B-Auth: nur tenant
3. KV-CAS-Decrement (oder DO für strikte Klassen): allowed?
4. Allowed: Headers setzen, weiter zur Route
5. Denied: 429 mit `Retry-After`-Header

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Rate-Limit überschritten             | `GH-RATE-001`    | 429, Retry-After-Header |
| Tier-Quota überschritten             | `GH-RATE-002`    | 429, Sunset-Header für Tagesreset |
| KV unerreichbar                      | `GH-INFRA-001`   | Fail-OPEN mit Warning-Log + Alert (lieber Abuse als Komplett-Down) |

## Fallbacks

- KV-Down → Fail-Open (mit Alert). Stricter-Mode-Setting (`fail_closed_on_kv_down`)
  als Tenant-Override für höhere Sicherheitsanforderungen.
- DO-Down (Login-Bucket) → Fail-Closed (Login geht nicht durch — sicherer als
  Brute-Force-Lücke).

## Backwards-Compat Implications

- Endpoint-Klassen-Namen permanent
- Header-Set permanent
- Tier-Namen permanent (`free`, `starter`, `pro`, `enterprise` — Vorschlag)

## Open Questions

- [x] ~~KV vs DO für Counter?~~ → **Hybrid**: KV-Default, DO für strikte Klassen
  (Login, Refresh, Magic-Link-Request) (2026-04-28).
- [x] ~~Tier-Schema?~~ → **4 Tiers** (`free`, `starter`, `pro`, `enterprise`)
  (2026-04-28). Reason: einfaches Mental-Modell, Tier-Wechsel als Tenant-Setting.

## Observability

- Counter `rate_limit.exceeded` pro Klasse + Tenant
- Histogram: `rate_limit.bucket_remaining_pct` (Trend-Indikator für Tier-Anpassung)

## Test Strategy

- Race-Test: 1000 parallele Requests mit Limit 100 → exakt 100 erfolgreich
- Cross-Customer-Test: Limit von Customer-A blockiert nicht Customer-B
- Header-Korrektheit auf jeder Response
- Fail-Open-bei-KV-Down (mocked)

## Learnings

→ `learnings/M15-rate-limiting.log.md`

## Plan Revisions Originating Here

(initial leer)
