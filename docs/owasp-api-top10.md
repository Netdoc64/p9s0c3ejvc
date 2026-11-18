# OWASP API Security Top 10 (2023) — Compliance-Audit

Pro OWASP-Punkt: **Status** + **Mitigation im Code** + **Restrisiko**.

## API1:2023 — Broken Object Level Authorization (BOLA)

**Status:** ✅ Addressed

**Mitigation:**
- Jeder Repo-Lookup ist tenant-scoped (`WHERE tenant_id = ?` + `WHERE customer_id = ?` für customer-self).
- Cross-Tenant-Access → 404 (kein 403 mit "verboten" — verhindert Information-Leak).
- MCP-Endpoint: Customer kann nur eigene Resources sehen (`auth.customer_id`-Check in jedem Tool-Handler).
- Order-Repo: `requireById(tenant_id, order_id)` wirft `GH-ORDER-001` für Cross-Tenant.

**Tests:** 7 Cross-Tenant-Tests in customers.spec.ts, fefo.spec.ts, dsgvo.spec.ts.

**Restrisiko:** Programmier-Fehler in zukünftigen Routes (vergessener tenant-Filter).
Mitigation: Test-Pattern "cross-tenant access → 404" in jedem neuen Modul.

## API2:2023 — Broken Authentication

**Status:** ✅ Addressed

**Mitigation:**
- HMAC-SHA256 mit konstante-Zeit-Vergleich (`constantTimeEqualHex`)
- 5min Clock-Skew-Toleranz
- API-Key-Hash in DB, niemals Klartext
- JWT HS256 mit per-Tenant-Secret (rotierbar mit 7d Karenz)
- Refresh-Token-Family-Replay-Detection: alter Token → ALLE Family-Tokens revoked
- Magic-Link 8-Char-Base32 (40 Bit Entropie), 10min TTL, 5 attempts max
- Strict-Rate-Limit DO-backed (`auth_login` 5/min, `magic_link_request` 3/min)
- Algorithm-Confusion-Schutz: nur HS256 explizit akzeptiert

**Tests:** 13+ JWT/PKCE/OAuth-Tests, Replay-Detection mit Family-Revocation, brute-force-rate-limit.

**Restrisiko:** Keine.

## API3:2023 — Broken Object Property Level Authorization (BOPLA)

**Status:** ⚠️ Partially Addressed

**Mitigation:**
- Zod-Schemas am Eingang validieren erlaubte Felder.
- Customer-PATCH erlaubt nur whitelisted Fields.
- Sanitize-Funktion in Customer-Routes filtert interne Felder vor Response.

**Restrisiko:** 
- Order-Doc `external_refs._pending_emits` ist intern — wird vor Persistierung extrahiert, aber wenn ein Caller sie via Mutator setzt, könnten sie versehentlich an Outbox emittiert werden. → **Plan-Revision**: explicit `extractInternal`-Pass in repos/orders.update.

## API4:2023 — Unrestricted Resource Consumption

**Status:** ✅ Addressed

**Mitigation:**
- Body-Size-Limits (5 MB für Bilder)
- CSV-Stream-Verarbeitung (kein Memory-Spike bei 10k Zeilen)
- Pagination-Limits (max 200 pro Request)
- Rate-Limits pro Klasse + Tier-Multiplikatoren
- Worker-CPU-Limit 30s (CF-default)
- D1-Statement-Limits (CF-default)

**Restrisiko:** 
- MCP-Tool kann theoretisch Listen-Tool im Loop aufrufen — kein per-tool Rate-Limit. → **Plan-Revision**: per-tool/per-customer Rate-Limits.

## API5:2023 — Broken Function Level Authorization

**Status:** ✅ Addressed

**Mitigation:**
- Zwei strikt getrennte Auth-Schemes: tenant_hmac (B2B) vs customer_jwt (Endkunden).
- B2B-Routes mounted unter `/v1/*` mit `auth()`-Middleware.
- Customer-Self-Routes unter `/v1/customer/*` mit `customerAuth()`-Middleware.
- MCP unter `/mcp` mit eigener Auth (Bearer JWT).
- Auth-Routes unter `/v1/auth/*` ist tenant-public (Slug-resolved).
- DSGVO-Pseudonymisierung erfordert Tenant-API-Key (nur Operator).

**Restrisiko:** Keine.

## API6:2023 — Unrestricted Access to Sensitive Business Flows

**Status:** ✅ Addressed

**Mitigation:**
- Two-Tool-Pattern für MCP: `create_order_draft` + `confirm_order` müssen separat aufgerufen werden.
- `GH-MCP-002` wenn Confirm ohne erlaubten State.
- Idempotency-Key verhindert Doppelausführung.
- Stock-Reservierung mit 2h TTL — verlässt selbst wenn Confirm vergessen wird.

**Restrisiko:** 
- Halluzinierender Agent könnte beide Tools im selben Turn aufrufen ohne Customer-Frage. → Doku-Punkt für SDK + Plan-Revision (temporal enforcement).

## API7:2023 — Server Side Request Forgery (SSRF)

**Status:** ✅ Addressed

**Mitigation:**
- Webhook-URLs werden nicht von Customer-Eingabe genommen, sondern Tenant-konfiguriert.
- Webhook-URL-Validation: `z.string().url()` — verhindert grobe Tippfehler, aber nicht Internal-Redirect-Tricks.
- VIES-Endpoint ist hardcoded (kein User-controllable URL).
- Pricing-Feed-URL ist Tenant-konfiguriert (Operator-Vertrauen).

**Restrisiko:** 
- Tenant könnte `webhook.url = http://internal-cf-ip:port` setzen → Worker pingt CF-internal. → **Plan-Revision**: URL-Allowlist für `https://`-only und no-private-IP-ranges.

## API8:2023 — Security Misconfiguration

**Status:** ⚠️ Partially Addressed

**Mitigation:**
- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- `wrangler.toml` mit Placeholder-IDs in main, Production-Override-Section dokumentiert.
- `.env.example` listet alle erforderlichen Secrets.
- DEPLOYMENT.md mit 11-Schritt-Pre-Production-Checkliste.
- CodeQL + Semgrep + gitleaks in CI.

**Restrisiko:** 
- Operator könnte Secrets falsch setzen. → DEPLOYMENT.md beschreibt explizit `wrangler secret put`-Pattern.
- CF-WAF/Bot-Management nicht im Code konfigurierbar. → SECURITY.md "Out-of-Code Maßnahmen".

## API9:2023 — Improper Inventory Management

**Status:** ✅ Addressed

**Mitigation:**
- OpenAPI 3.1 Spec auf `/openapi.json` mit allen 28 Pfaden.
- KNOWN_PATHS-Drift-Test: jeder neue Pfad muss in der Spec gelistet sein, sonst CI fails.
- API-Versionierung: `/v1/*` permanent stable.
- Deprecation-Lifecycle in `_backwards-compat.md`.
- Schema-Versionen: `build-plan/1.0`, `order-document/1.0` separat versioniert.

**Restrisiko:** Keine.

## API10:2023 — Unsafe Consumption of APIs

**Status:** ⚠️ Partially Addressed

**Mitigation:**
- VIES: 5s-Timeout, Fallback auf `vat_status: unknown`, KV-Cache 24h.
- Resend (Email): error wirft, Magic-Link-Request gibt 503 wenn unreachable.
- Webhook-Receiver: 10s-Timeout, kein blind Trust auf Receiver-Response-Body.
- Pricing-Feed: Drift-Detection (>50% auf >5% SKUs blockiert Switch).

**Restrisiko:** 
- Pricing-Feed-Adapter sind v1 nur `csv-generic`. Aalsmeer/RBC haben keine SSL-Pinning, keine Schema-Validation. → **Plan-Revision**: Schema-validierende Adapter.
- Webhook-Receiver-Response wird nicht geparst (nur status-code). Kein Risiko, aber auch keine Insights.

## Zusammenfassung

| OWASP-Punkt | Status |
|---|---|
| API1 BOLA | ✅ |
| API2 Broken Auth | ✅ |
| API3 BOPLA | ⚠️ (1 Plan-Revision) |
| API4 Resource Consumption | ✅ |
| API5 Broken Function Auth | ✅ |
| API6 Sensitive Business Flows | ✅ |
| API7 SSRF | ✅ (1 Plan-Revision) |
| API8 Security Misconfiguration | ⚠️ (Operator-Pflicht) |
| API9 Improper Inventory | ✅ |
| API10 Unsafe API Consumption | ⚠️ (Plan-Revision Aalsmeer/RBC) |

**3 Plan-Revisions identifiziert**, alle additiv, keine Showstopper für Pilot.
