---
module_id: M03_tenants
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P1_foundation
---

# M03 — Tenant + API-Key Model

## Goal

Datenmodell und Bootstrap-Pfad für Mandanten und ihre API-Keys, sodass M04+
gegen einen real existierenden Tenant arbeiten kann.

## Non-Goals

- Kein Tenant-Self-Service-Onboarding (manueller CLI-Bootstrap reicht für v1)
- Keine Sub-Mandanten / Hierarchien
- Keine Quota-/Plan-Management-Logik (Felder ja, Enforcement später)

## Success Criteria

- `pnpm bootstrap-tenant --name pilot --country NL --currency EUR`
  erzeugt Tenant + ersten API-Key + HMAC-Secret
- M02-Auth-Middleware findet diesen Tenant über den Key
- Mehrfacher Bootstrap derselben `name`-Slug ist idempotent (oder klarer Fehler)

## Execution Intent (Vibe)

- Klein und scharf. Dies ist ein „Kümmer-Modul", keine Domäne.
- HMAC-Secret beim Erzeugen einmalig zurückgeben, nie wieder zeigen.
- API-Key-Hash gespeichert, Klartext nur im Bootstrap-Output.

## Inputs Required

- M02 fertig (Auth liest hier ein)
- ID-Format: `t_<ulid>`, `k_<ulid>`

## Deliverables

```
migrations/00XX_tenants.sql            tenants, api_keys
src/repos/tenants.ts                   tenant-scoped Lookups
src/repos/api-keys.ts
scripts/bootstrap-tenant.ts            CLI
tests/repos/tenants.spec.ts
```

## Happy Path

1. CLI: `pnpm bootstrap-tenant --name "Pilot Blumen-Grosshandel" --country NL --currency EUR --slug pilot`.
2. Slug-Normalisierung (lowercase, ASCII, `-`-getrennt). `SELECT FROM tenants WHERE slug=?`. Wenn vorhanden + nicht `deleted_at` → klare Fehlermeldung mit existierender `tenant_id` und Exit-Code 1.
3. Generiere `tenant_id = "t_" + ulid()`, `api_key_id = "k_" + ulid()`, `api_key_plain = "gh_" + base64url(random(32))`, `hmac_secret = base64url(random(32))`, `customer_jwt_secret = base64url(random(32))`.
4. In einer D1-Transaktion: `INSERT INTO tenants (id, slug, name, country, currency, customer_jwt_secret, created_at)` + `INSERT INTO api_keys (id, tenant_id, key_hash=sha256(api_key_plain), hmac_secret, name="bootstrap", scope="full", revoked_at=NULL, created_at)`.
5. CLI gibt einmalig auf stdout aus: `tenant_id`, `api_key_id`, `api_key_plain`, `hmac_secret` (Klartext, nur dieses eine Mal — Hinweis im Output).
6. Repo-Test: `tenants.findById(tenant_id)` liefert den Tenant; `api-keys.findByPlain(api_key_plain)` führt M02-Auth-Flow durch und gibt denselben Tenant zurück.

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Tenant existiert bereits             | `GH-TENANT-002`  | klare CLI-Fehlermeldung |
| API-Key-Lookup misslingt             | `GH-AUTH-001`    | aus M02 |

## Fallbacks

- Bootstrap auf vorhandener DB ohne Migrations → Fehler, klar markiert.

## Backwards-Compat Implications

- `tenants.id`-Format `t_<ulid>` permanent
- `api_keys`-Schema: API-Keys werden nie umgeschrieben, nur revokiert
  (Soft-Status-Feld), damit historische Logs nachvollziehbar bleiben

## Open Questions

- [x] ~~Mehrere API-Keys pro Tenant?~~ → **Ja, mit `revoked_at`-Spalte** (2026-04-28).
  Reason: Rotation ohne Downtime ist Pflicht in B2B-API-Welt; Single-Key-Constraint
  wäre artificial.
- [x] ~~Tenant-Soft-Delete vs. Hard-Delete?~~ → **Soft-Delete (`deleted_at`)** (2026-04-28).
  Reason: alle Audit-/Order-Daten referenzieren Tenant-ID; Hard-Delete würde
  Foreign-Keys brechen oder Cascading-Loss erzeugen.

## Observability

- Log bei Bootstrap (One-Time-Event), Tenant-ID + Key-Prefix
- Metric: `auth.tenant.distinct_count` täglich

## Test Strategy

- Bootstrap-Idempotenz
- Tenant-Repo: Lookup, Update, Revoke
- API-Key-Repo: Hash-Vergleich

## Learnings

→ `learnings/M03-tenants.log.md`

## Plan Revisions Originating Here

(initial leer)
