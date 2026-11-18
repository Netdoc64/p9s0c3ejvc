---
module_id: M14_seed_pilot
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P4_eventing_and_clients
---

# M14 — Pilot-Seed (Blumen-Grosshandel)

## Goal

Realistischer Datensatz, mit dem der Pilot ohne manuelle Eingabe lauffähig ist:
Tenant, ein paar Test-Kunden in EU/CH, ~50 Test-SKUs, Preisliste, Mengenstaffel,
Steuerregeln. Ein Smoke-Test-Skript fährt eine End-to-End-Order durch.

## Non-Goals

- Keine echten Stammdaten des Pilot-Kunden — nur plausibler Test-Datensatz
- Keine Lasttests (anderes Modul, falls je nötig)

## Success Criteria

Wie Build-Plan `M14_seed_pilot.acceptance[]`. Zusätzlich:

- Frischer DB-Stand: `pnpm seed:pilot && pnpm smoke` → grün
- Smoke-Test ist deterministisch (gleiche Idempotency-Keys → gleiche IDs)

## Execution Intent (Vibe)

- Idempotente Seeds (Re-Run zerstört nichts, ergänzt nur Fehlendes)
- Datensatz so wählen, dass er die Edge-Cases der Tax/Pricing-Engines exerciert:
  - DE-B2B-Standard, NL-B2B-Reverse-Charge, CH-Export, mind. ein Mengenstaffel-Treffer
- Smoke-Test simuliert Floraly-Bestellung über REST UND MCP

## Inputs Required

- Alle vorigen Module fertig
- Bootstrap-Tenant-CLI (M03)

## Deliverables

```
scripts/seed-pilot.ts                  CLI
scripts/smoke.ts                       E2E-Smoke-Test
tests/smoke/floraly-order.spec.ts      Vitest-Variante
```

## Happy Path

**Seed:**
1. `pnpm seed:pilot` ruft `scripts/seed-pilot.ts`.
2. Faker-Setup mit `faker.seed(20260428)` und festen ID-Konstanten (`t_pilot`, `cust_floraly_de`, `cust_blume_nl`, `cust_florex_ch`).
3. Idempotenz: vor Insert prüfen (`SELECT … WHERE id=?`), nur fehlende Datensätze ergänzen.
4. Schritte:
   - Tenant `t_pilot` (NL, EUR) + 1 API-Key + HMAC-Secret (printed).
   - 3 Customers: Floraly (DE-B2B + valid VAT), Blume (NL-B2C, no VAT), Florex (CH-B2B + valid VAT).
   - 1 Warehouse `wh_main` in NL.
   - 50 SKUs (Faker-erzeugte Roses/Tulips/Gerbera, fix-seeded → reproduzierbare `sku_*`-IDs), je `parent_sku_id` für Längen-Varianten.
   - 1 `price_list` (EUR) + 50 `price_list_items` + 5 `qty_breaks` (10/25/50/100/250 Karton) + 2 `customer_special_prices` für Floraly.
   - `tax_rules`: NL-Standard 21%, EU-B2B Reverse-Charge, CH-Export 0%, NL-B2C 21%.
   - Initial-Stock: pro SKU 100 Karton in `wh_main` (`POST /v1/stock/movements`).
5. Output: Tenant-Bootstrap-Credentials + Liste der Seed-Resource-IDs.

**Smoke:**
6. `pnpm smoke` ruft `scripts/smoke.ts`.
7. HMAC-signed `POST /v1/orders` mit `customer_id=cust_floraly_de`, 10 Karton einer Roses-SKU, `Idempotency-Key=smoke-001`.
8. Assert 201, Doc.state.current === `awaiting_confirmation`, Tax-Scheme `reverse_charge_eu`.
9. `POST /v1/orders/:id/confirm`. Assert 200, Doc.state.current === `confirmed`, Stock-Movement angelegt.
10. Optional: MCP-Smoke — JWT für Floraly, `create_order_draft` + `confirm_order` via MCP-Endpoint.
11. CI-Variante als Vitest in `tests/smoke/floraly-order.spec.ts` mit miniflare.

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Seed gegen DB mit existierenden Daten | siehe M03-Idempotenz | Re-Run merged |
| Smoke fail                           | jeweiliger Code  | CI bricht |

## Fallbacks

- VIES nicht erreichbar während Smoke → Test-Customer mit `vat_status: unknown`
  als Variante eingebaut, Smoke geht durch

## Backwards-Compat Implications

- Seed-Tenant-ID `t_pilot` permanent (CI/Staging hängt dran)
- Seed-Customer-IDs permanent (Snapshot-Tests referenzieren)

## Open Questions

- [x] ~~Seed-Datensatz committed vs generiert?~~ → **Generiert via Faker mit
  fixed Seed** (2026-04-28). Reason: reproduzierbar (gleiche IDs run-zu-run),
  kein Repo-Bloat. Fixe Seed-Werte für Tenant-/Customer-/SKU-IDs damit
  Snapshot-Tests stabil bleiben.

## Observability

- Smoke-Dauer als CI-Metrik (zu lang = Performance-Regression)

## Test Strategy

- `seed && smoke` läuft in CI auf jedem PR
- Snapshot der erzeugten Order-Document-Struktur (zeigt Regressions an Schema)

## Learnings

→ `learnings/M14-seed-pilot.log.md`

## Plan Revisions Originating Here

(initial leer)
