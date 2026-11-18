---
module_id: M09_order_doc
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P3_orders
---

# M09 — Order Document Schema + Storage

## Goal

Implementierung des Order-Document-Schemas (siehe [`order-document.md`](../order-document.md))
als Zod, mit hybrider D1-Persistenz: Header+Lines normalisiert für Queries,
plan/gates/audit/issues als JSON-Spalte. Etag-basiertes Optimistic Locking.

## Non-Goals

- Kein Orchestrator-Code (M10)
- Keine REST-Endpoints (M11)
- Kein Sub-Document-Mechanismus (Retoure, Teillieferung) — Open Question

## Success Criteria

- Round-Trip: Zod-Object → DB → Zod-Object identisch (Snapshot-Test)
- Concurrent-Update mit altem etag → 409 `GH-ORDER-002`
- JSON-Schema-Export unter `/schemas/order.json` erreichbar
- Schema-Version `order-document/1.0` im Doc, Reader prüft Version

## Execution Intent (Vibe)

- Zod ist Master, JSON-Schema generiert
- Hybrid-Storage: header/lines normalisiert (für Filter/Sort), Rest JSON-Blob
- Niemals direkt mutieren — immer „read → modify → save with etag"
- ETag = sha256 des serialisierten Doc

## Inputs Required

- M03 fertig (Tenant-Context)
- Order-Document-Doc als Spec-Wahrheit
- Antwort auf Sub-Document-Frage

## Deliverables

```
src/schemas/order.ts                   Zod-Schema mit OpenAPI-Annotations
src/schemas/order.json-schema.ts       Export
migrations/00XX_orders.sql             orders, order_lines
src/repos/orders.ts                    mit etag-Locking
tests/repos/orders.spec.ts
```

## Happy Path

**Create:**
1. Caller (M11) ruft `repos.orders.create(doc)`.
2. Zod-Parse `OrderDocSchema` (strikt). Bei Failure → `GH-INPUT-001`.
3. Deterministisches Serialisieren (`canonicalize` — Keys sortiert, no-whitespace) → `etag = sha256(canonical)`.
4. Header-Daten extrahieren (id, tenant_id, customer_id, state.current, total_cents, created_at, schema_version).
5. In einer D1-Tx: `INSERT orders (...) VALUES (..., plan=JSON, audit=JSON, gates_log=JSON, etag)` + per Line `INSERT order_lines (order_id, line_no, sku_id, qty, unit_price_cents, tax_scheme, tax_rate_pct, line_total_cents)`.
6. Return Doc inkl. `etag`.

**Read:**
7. `repos.orders.findById(id)`: tenant-scoped Query → load header + lines, parse JSON-Spalten, zusammenbauen → Zod-Forward-Compat-Reader (akzeptiert future Minor-Versionen, ignoriert unknown).

**Update (Optimistic Lock):**
8. `repos.orders.update(id, expected_etag, mutator)`:
9. `findById` → Doc + current_etag.
10. Wenn `current_etag !== expected_etag` → `GH-ORDER-002` 409.
11. `new_doc = mutator(doc)`. Re-Validate Zod. Re-canonicalize → `new_etag`.
12. In Tx: `UPDATE orders SET ... WHERE id=? AND etag=?` (Compare-and-Swap). Wenn `rowsAffected === 0` → `GH-ORDER-002` (Race lost).
13. Lines: bei Änderung DELETE+INSERT für betroffene line_no (oder full replace bei Schema-Klärung).
14. Return `{doc: new_doc, etag: new_etag}`.

**Schema-Export:**
15. `GET /schemas/order.json`: gibt JSON-Schema, das aus Zod-Schema via `zod-to-json-schema` zur Build-Zeit generiert und im Worker-Asset eingebunden ist.

## Error Paths

| Symptom                       | Code             | Recovery |
|-------------------------------|------------------|----------|
| Order nicht gefunden          | `GH-ORDER-001`   | 404 |
| Etag-Mismatch                 | `GH-ORDER-002`   | 409, Client soll re-fetch + retry |
| Schema-Validation fehlgeschl. | `GH-INPUT-001`   | 400 |

## Fallbacks

- Falls JSON-Spalte zu gross für D1-Limit (hochunwahrscheinlich, aber): Audit
  ausgliedern in eigene Tabelle.

## Backwards-Compat Implications

- Schema-Version-Bump nach Regeln aus `_backwards-compat.md`
- Gespeicherte Docs werden NICHT retroaktiv migriert (Reader-Forward-Compat)
- Felder im Doc niemals umbenennen

## Open Questions

- [x] ~~Sub-Documents embedded vs eigene `doc_type`s?~~ → **Eigene `doc_type`s**
  (`credit_note`, `shipment`, `return`) mit `parent_order_id` (2026-04-28).
  Reason: eigenständige Lifecycle, einzeln versionierbar (`credit_note/1.0`),
  saubere Audit-Trennung. Order bleibt schmal.
- [x] ~~`gates`/`plan`/`audit` als ein Blob oder mehrere?~~ → **Drei separate
  JSON-Spalten** (`orders.plan`, `orders.audit`, `orders.gates_log`) (2026-04-28).
  Reason: Orchestrator schreibt `plan` häufig, Audit-Append schreibt `audit` —
  getrennte Spalten verhindern Conflict-on-Save bei Concurrent-Writers innerhalb
  einer Transaktion.

## Observability

- Order-Anzahl pro State (Gauge)
- Etag-Conflict-Rate (Indikator für Concurrent-Edit-Probleme im Frontend)

## Test Strategy

- Round-Trip aller Beispiele aus order-document.md
- Concurrent-Update-Test
- Schema-Version-Reader-Tests (alt + neu lesen)

## Learnings

→ `learnings/M09-order-doc.log.md`

## Plan Revisions Originating Here

(initial leer)
