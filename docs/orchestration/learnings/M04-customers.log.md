# M04 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7 (build run #1)

### What happened
Customer-CRUD (POST/GET/PATCH/DELETE/list) mit Cursor-Pagination, VIES-Service mit KV-Cache (24h TTL) + Timeout-Fallback (5s → status="unknown"), Cross-Tenant-Isolation (404 statt 403), VAT-ID-Uniqueness-Constraint pro Tenant, addresses/metadata als JSON-Spalten.

### Decisions
1. **VIES via REST-Proxy** (`https://ec.europa.eu/taxation_customs/vies/rest-api/...`) statt SOAP. Reason: einfacher, JSON-nativ. Falls EU den Endpoint deprecated → Adapter swappen.
2. **`setViesClient`-Test-Hook** statt Dependency-Injection durch alle Routen — pragmatisch für v1, M06+ wird DI sauberer machen falls nötig.
3. **Soft-Delete via `deleted_at`-Spalte** + UNIQUE-Index `WHERE deleted_at IS NULL`. Erlaubt Wiederverwendung der gleichen VAT-ID nach Löschung.
4. **`addresses` als JSON** statt separate Tabelle (M04-OQ-Decision: 1:1 reicht für v1).
5. **Cross-Tenant-404 ist `GH-CUST-001`**, nicht `GH-TENANT-001` — beide gleiche http_status, aber `GH-CUST-001` ist domänenspezifisch (Customer not found in tenant).
6. **Cursor opaque base64({created_at, id})** — Spec für M11, hier konsistent angewendet.

### Tests
- 7 Tests: create-no-vat, create-valid-vat, vies-timeout, dup-vat (409), invalid-body, cross-tenant-404, patch-vat-skipCache

### Confidence
high — alle Acceptance-Kriterien (VIES-Mock-Tests, 24h-Cache, Timeout-Fallback, Cross-Tenant) durch Tests belegt.

### Bewusst nicht in v1
- DSGVO-Pseudonymisierungs-Service (M04-OQ): wird Plan-Revision wenn 1. Antrag eingeht.
- `email`/`phone`-Validierung über pattern hinaus (z.B. Twilio-Lookup).
