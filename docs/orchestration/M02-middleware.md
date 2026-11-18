---
module_id: M02_middleware
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P1_foundation
---

# M02 — Cross-Cutting Middleware

## Goal

Request-ID, structured Logging, RFC-7807-Errors, Auth (X-Api-Key + HMAC),
Idempotency-Layer, Tenant-Resolution — alle Querschnitts-Concerns als Hono-Middleware,
wiederverwendbar für jede Route.

## Non-Goals

- Keine Rate-Limiting-Logik (kann später als zusätzliche Middleware ergänzt werden)
- Keine MCP-OAuth (M13)
- Keine Audit-Persistenz (separates Modul, falls je nötig)

## Success Criteria

Wie Build-Plan `M02_middleware.acceptance[]`. Zusätzlich:

- Idempotency-Layer cached **nur** Erfolgs-Responses (4xx/5xx werden re-evaluiert)
- HMAC-Verify nutzt konstante-Zeit-Vergleich
- Cross-Tenant-Test in Integration: Tenant-A-Key auf Tenant-B-Resource → 404,
  kein Leak im Body, kein Detail-Log auf Public-Logs

## Execution Intent (Vibe)

- Mehrere kleine Middlewares > eine grosse — komponierbar
- Auth-Middleware setzt `c.set("tenant_id", ...)`, alle Routes lesen daraus —
  Tenant ist nie URL-Parameter
- Idempotency: Hash der Request-Payload + Tenant + Idempotency-Key → KV-Lookup
- Logger emittiert **strukturiertes** JSON, nicht Strings

## Inputs Required

- M01 fertig (Skeleton + Env-Type)
- Cross-Cutting `auth`-Block (Header-Set + Skew-Tolerance)
- `_errors.md` mit AUTH-/IDEMP-/TENANT-Codes (steht)

## Deliverables

```
src/middleware/request-id.ts
src/middleware/logger.ts
src/middleware/error.ts          → Problem-JSON-Mapper
src/middleware/auth.ts           → API-Key-Lookup + HMAC + Skew-Check
src/middleware/idempotency.ts    → KV-backed, TTL 24h
src/middleware/tenant.ts         → setzt c.var.tenant_id (eigentlich Teil von auth, aber separat klarer)
tests/middleware/*.spec.ts
```

## Happy Path

1. Request trifft auf Hono-App. `request-id`-Middleware setzt `c.var.request_id` (ULID, ohne Prefix) und Response-Header `X-Request-Id`.
2. `logger`-Middleware startet Timer, sammelt Pflichtfelder (`request_id`, `route`, später `tenant_id`, `status`, `duration_ms`).
3. `auth`-Middleware liest `X-Api-Key`, `X-Signature`, `X-Timestamp`. Skew-Check (±300s). Lookup `api_keys` (hash-Vergleich, konstante Zeit). HMAC-SHA256 über `<method>\n<path>\n<timestamp>\n<body-sha256>` mit `tenant.hmac_secret`, konstante-Zeit-Vergleich. Bei Erfolg setzt `c.var.tenant_id` + `c.var.api_key_id`.
4. `idempotency`-Middleware (nur bei `POST`/`PATCH`/`PUT`): wenn Header `X-Idempotency-Key` gesetzt → Hash `sha256(tenant_id + key + route + body)` → KV-Lookup. Cache-Hit mit gleichem Hash → cached Response (Status 2xx) zurück. Cache-Hit mit anderem Hash → `GH-IDEMP-001` 409. Cache-Miss → Request weiterleiten, Response (nur 2xx) als JSON in KV mit TTL 24h speichern.
5. Route-Handler läuft. Wirft entweder Coded-Error (`throw new CodedError("GH-...")`) oder gibt Response zurück.
6. `error`-Middleware fängt geworfene Errors. Coded-Error → `_errors.md`-Lookup → RFC-7807-Body (`type`, `title`, `status`, `detail`, `instance=request_id`). Unbekannter Error → `GH-INFRA-002` 500.
7. `logger`-Middleware schreibt finalen JSON-Log mit `duration_ms`, `status`, ggf. `error_code`, `idempotency_hit`.

## Error Paths

| Symptom                    | Code             | Recovery |
|----------------------------|------------------|----------|
| Header `X-Api-Key` fehlt   | `GH-AUTH-001`    | 401, kein Retry |
| Signatur stimmt nicht      | `GH-AUTH-002`    | 401 |
| Timestamp out-of-skew      | `GH-AUTH-003`    | 401 |
| Doppelter Key, anderer Body| `GH-IDEMP-001`   | 409 |
| Cross-Tenant-Zugriff       | `GH-TENANT-001`  | 404 (intentional, kein 403) |

## Fallbacks

- KV nicht verfügbar (Idempotency lookup) → Fail-open mit Log-Warning UND
  Metric-Spike → Alert. Niemals Fail-closed (würde alle Schreib-Anfragen
  blockieren).

## Backwards-Compat Implications

- Auth-Header-Set ist permanent: `X-Api-Key`, `X-Signature`, `X-Timestamp`,
  `X-Idempotency-Key`. Hinzufügen ja, umbenennen nie.
- HMAC-Algorithmus festgelegt (SHA256). Wechsel nur per Migrations-Plan
  (Doppellauf 2 Versionen lang).

## Open Questions

- [x] ~~Idempotency-Window pro Route oder global 24h?~~ → **Global 24h** (2026-04-28).
  Reason: simpler Default; Override pro Route ist additive Erweiterung, kein
  Build-Blocker.
- [x] ~~Logger-Sink~~ → **Workers-Logs für v1, Logpush als Plan-Revision** (2026-04-28).
  Reason: kostenlos, eingebaut; Logpush nach R2 oder externer Sink kommt mit
  konkretem Ops-Bedarf.

→ Modul ist `unblocked`.

## Observability

- Pflicht-Log-Felder: `request_id`, `tenant_id` (falls aufgelöst), `route`,
  `status`, `duration_ms`, `idempotency_hit: bool`
- Metrik: `auth.failure.rate` pro Tenant (Anomalie = potential Abuse)

## Test Strategy

- Unit pro Middleware
- Integration: Request-Pipeline durchlaufen, alle Header-Kombinationen
- Stress: Idempotency mit 1000 parallelen identischen Requests → 1× echter Run,
  999× Cache-Hit

## Learnings

→ `learnings/M02-middleware.log.md`

## Plan Revisions Originating Here

(initial leer)
