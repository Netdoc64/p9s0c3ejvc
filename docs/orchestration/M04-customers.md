---
module_id: M04_customers
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M04 — Customers + VIES

## Goal

Kunden-Stammdaten mit VAT-ID-Validierung gegen VIES (cached, fallback-tolerant),
Credit-Feldern und einem REST-CRUD-Interface.

## Non-Goals

- Keine Adress-Verifizierung (z.B. Google/Postcode-API) — kommt ggf. später
- Keine Kontakt-Hierarchien (Ansprechpartner mehrfach pro Kunde) — v1 hat
  ein Ansprechpartner-Feld inline

## Success Criteria

Wie Build-Plan `M04_customers.acceptance[]`. Zusätzlich:

- VIES-Adapter ist isoliert (`src/services/vies.ts`) — testbar mit Mock
- Cache-Hit innerhalb 24h, kein Re-Check (siehe Order-Document-Beispiel,
  `cache_age_hours`)
- VIES-Timeout/5xx → status `unknown` mit Warning, NICHT 5xx an Client

## Execution Intent (Vibe)

- VIES-Adapter mit Timeout 5s, dann Fallback. **Niemals** synchroner Call mit
  >5s blockierend.
- Cache-Layer in KV mit Key `vies:<vat_id>` und TTL 24h.
- Credit-Felder als Integer (Cents), gleiche Regel wie Money.

## Inputs Required

- M03 fertig (Tenant-Context für alle Customer-Operationen)
- Cross-Cutting `money_representation`
- Antwort auf Open-Question (Credit-Limit-Währung)

## Deliverables

```
migrations/00XX_customers.sql
src/repos/customers.ts                 tenant-scoped
src/services/vies.ts                   mit KV-Cache
src/services/vies.mock.ts              für Tests
src/routes/customers.ts                CRUD + GET /customers/:id
src/schemas/customer.ts                Zod
tests/services/vies.spec.ts
tests/routes/customers.spec.ts
```

## Happy Path

1. `POST /v1/customers` mit Body `{name, email, vat_id?, country, b2b_b2c, billing_address, shipping_address?, credit_limit_cents?}` und Idempotency-Key.
2. M02-Pipeline (Auth + Tenant + Idempotency). Zod-Parse erzwingt `country` als ISO-3166-2, `currency` aus Tenant.
3. Conflict-Check: `SELECT FROM customers WHERE tenant_id=? AND vat_id=?` → bei Treffer `GH-CUST-002` 409 (mit `existing_customer_id`).
4. Wenn `vat_id` gesetzt: `vies.lookup(vat_id)`. Cache-Lookup `KV.get("vies:" + vat_id)`. Cache-Miss → VIES-SOAP-Call mit 5s-Timeout. Erfolg → `vat_status: "valid"|"invalid"`, KV-Put mit TTL 24h. Timeout/5xx → `vat_status: "unknown"`, Warning-Log mit `GH-VIES-002`. Wenn kein `vat_id` und `b2b_b2c="b2b"` → `vat_status: "not_required"`, sonst `vat_status: "not_required"` für b2c.
5. `INSERT INTO customers (id="cust_"+ulid(), tenant_id, vat_id, vat_status, vies_checked_at, ..., addresses=JSON.stringify(...))`.
6. Response 201 mit Customer-Resource (sanitized — interne Felder wie `vies_raw_response` nicht im Output).
7. Bei `GET /v1/customers/:id`: Repo-Lookup tenant-scoped, 404 `GH-TENANT-001` falls Cross-Tenant.
8. Bei `PATCH /v1/customers/:id` mit neuer `vat_id`: erneuter VIES-Call (Cache-Bypass), Update `vat_status` + `vies_checked_at`.

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Customer nicht gefunden              | `GH-CUST-001`    | 404 |
| Doppelte VAT-ID innerhalb Tenant     | `GH-CUST-002`    | 409 |
| VIES sagt invalid                    | `GH-VIES-001`    | 422 (oder weicher: Customer wird angelegt mit `vat_status: invalid`?) |
| VIES timeout/5xx                     | `GH-VIES-002`    | Customer wird angelegt mit `vat_status: unknown` + Warning-Log; **nicht** 5xx |

## Fallbacks

- VIES dauerhaft down (>1h) → Tenant-Setting `allow_unknown_vat: true|false`
  steuert, ob Bestellungen mit `unknown` Status durchlaufen
  (Empfehlung default `true` mit Warning-Tag in Order-Document)

## Backwards-Compat Implications

- Customer-Schema-Felder permanent additiv
- `vat_status`-Enum: `valid` | `invalid` | `unknown` | `not_required`
  → Werte werden nie umbenannt, nur ergänzt

## Open Questions

- [x] ~~Credit-Limit pro Währung?~~ → **Tenant-Currency only für v1** (2026-04-28).
  Reason: Pilot ist EUR-only. Erweiterung zu `credit_limits[]` als Array ist
  additiv, kein Breaking-Change.
- [x] ~~Soft-Delete vs. Anonymisierung?~~ → **Beides: Soft-Delete als Default,
  Pseudonymisierungs-Service für DSGVO-Anträge** (2026-04-28). Reason: 10-Jahre-
  Aufbewahrungspflicht für Bestellunterlagen vs. Recht auf Vergessenwerden →
  Kompromiss durch Pseudonymisierung der PII bei gleichzeitiger Bewahrung der
  Geschäftsdaten.
- [x] ~~Adressen embedded oder separate Tabelle?~~ → **Embedded JSON-Spalte für v1**
  (eine billing, eine shipping; 2026-04-28). Reason: 1:1-Beziehung im Pilot;
  Mehrfach-Adressen via separater Tabelle ist additiv (`addresses[]`-Spalte
  bleibt, neue Tabelle ergänzt).

## Observability

- VIES-Erfolgsrate, p99-Latenz, Cache-Hit-Rate
- Customer-Create-Rate pro Tenant

## Test Strategy

- VIES-Mock mit vorgegebenen Antworten
- Cache-Verhalten (Frisch/Stale/Refresh)
- Cross-Tenant-Test (Tenant-A liest nie Tenant-B)
- Concurrent VAT-ID-Conflict (zwei Anlagen gleichzeitig)

## Learnings

→ `learnings/M04-customers.log.md`

## Plan Revisions Originating Here

(initial leer)
