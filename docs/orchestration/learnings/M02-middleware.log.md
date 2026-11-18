# M02 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7 (build run #1)

### What happened
Vollständige M02-Middleware-Pipeline implementiert: request-id, logger, error-Handler (RFC-7807), auth (X-Api-Key + HMAC-SHA256 + 5min-Skew), idempotency (KV-backed, 24h TTL, fail-open). Worker-App neu strukturiert: `/health` öffentlich, `/v1/*` mit auth+idempotency.

### Decisions taken
1. **Migration `0002_tenants.sql` enthält `tenants` + `api_keys`-Schema.** Build-Plan-Spec hat M03 als „Tenant + API-Key Model" (depends_on M02). Aber M02-Auth braucht das Schema, um den Lookup zu machen. Kausalität-Fix: Schema in M02-Migration, M03 fügt nur Bootstrap-CLI + Repos darauf.
   **Confidence: high.**
   **Proposed revision:** Build-Plan Klarstellung — `M02_middleware.deliverables` enthält Migration für `tenants` + `api_keys`; `M03_tenants.deliverables` fokussiert auf Bootstrap-CLI und Repo-Wrapper.

2. **HMAC-Signing-String:** `<METHOD>\n<pathname>\n<timestamp>\n<sha256(body)>`. Body wird gehashed (nicht direkt mitsigniert), damit grosse Bodies kein Memory-Problem werden. Konstante-Zeit-Vergleich des Hex-Outputs (`constantTimeEqualHex`).

3. **`v1`-Subrouter** statt einzelner `app.use` pro Route — alle authentifizierten Routes sind `/v1/*`. Macht es trivial, weitere Module zu mounten ohne pro Route auth+idempotency zu wiederholen.

4. **`X-Idempotency-Hit: true`-Header** als Signal für Caller. Kein Body-Bestandteil, weil RFC-7807-konform und kein „Cache-Hit" als Domain-Konzept im Body.

5. **`@cloudflare/vitest-pool-workers` mit `applyD1Migrations`-Pattern**: Migrations werden bei Start der Test-Worker-Pool als Binding `TEST_MIGRATIONS` injiziert; `tests/_setup/apply-migrations.ts` als globaler `beforeAll` führt sie auf jeder isolierten D1-Instanz aus. Saubere, kanonische Lösung.

6. **`tests/_setup/seed.ts`-Helper** + `tests/_setup/sign.ts`-Helper für HMAC-signed Requests — wiederverwendbar für jedes spätere M03+-Test-Modul. Spart pro Modul ~20 Zeilen Boilerplate.

7. **`logger.ts`: Health-Spam unterdrückt** (siehe M01-Spec). Alle anderen Routes loggen JSON mit `tenant_id`, `request_id`, `route`, `status`, `duration_ms`, optional `error_code` und `idempotency_hit`.

8. **Idempotency cached nur 2xx.** 4xx/5xx werden re-evaluiert (Spec). Verhindert „cached 401" wenn API-Key später valid wird.

### Confidence
high — alle Build-Plan-Acceptance-Kriterien plus M02-Modul-Spec (Cross-Tenant-404, fehlende Header → 401, HMAC-mismatch → 401, gleicher Idempotency-Key/anderer Body → 409) durch Tests abgedeckt.

### Test-Coverage
- request-id.spec: 2 Tests (generation, echo)
- error.spec: 2 Tests (CodedError → 7807, unknown → 500)
- auth.spec: 7 Tests (missing key, missing sig, skew, unknown key, HMAC mismatch, valid pass-through, tenant_id-Setzung)
- idempotency.spec: 4 Tests (no-key passthrough, hit, conflict 409, GET ignored)

### Proposed revisions
- `M02-middleware.md` Deliverables: Migration `0002_tenants.sql` ergänzen.
- `M03-tenants.md` Deliverables: Migrations entfernen (jetzt in M02), nur Bootstrap-CLI + Repos.
- Beide Module: Cross-Reference auf das geteilte Schema.

### Follow-ups
- M03 ergänzt nur `src/repos/tenants.ts`, `src/repos/api-keys.ts`, `scripts/bootstrap-tenant.ts`.
- M02b nutzt `tenants.customer_jwt_secret` (bereits in Schema vorhanden).
- M15 (Rate-Limiting) baut weitere Middleware auf demselben Pattern.

## 2026-11-17 — Replay-Cache traf parallele Lesezugriffe

Der Lasttest (`pnpm load`) bekam für 47 % der Suchanfragen `401`: zwei identische GETs in derselben Sekunde tragen dieselbe Signatur, und der Replay-Cache (#A-014) ließ jede Signatur nur einmal zu. Jetzt nur noch für schreibende Methoden — ein wiederholter Lesezugriff ändert nichts, und jeder GET sparte sich einen KV-Schreibvorgang (Suche p50 151 → 78 ms). `tests/middleware/auth.spec.ts` hält beide Richtungen fest. Identische POSTs in derselben Sekunde bleiben (gewollt) abgewiesen; Clients machen sie über einen Zeitstempel im Body oder einen `X-Idempotency-Key` eindeutig.
