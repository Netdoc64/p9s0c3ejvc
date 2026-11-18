---
module_id: M21_perishability
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M21 — Perishability + FEFO + Bruch/Schwund

## Goal

Korrekte Bestandsführung für verderbliche Ware: pro SKU mehrere Batches mit
Mindesthaltbarkeitsdatum (MHD); Reservierungen greifen FEFO (First-Expired-First-Out);
Bruch/Schwund/Qualitätsausschluss als kategorisierte Stock-Movements.

## Non-Goals

- Kein Cold-Chain-Monitoring (Temperatur-Tracking) — separates Modul falls je nötig
- Keine Lieferanten-Rückverfolgung pro Batch (wäre Pharmaspezifisch); Batch-ID
  reicht für interne Audit

## Success Criteria

- Stock-DO hält pro SKU eine Batch-Liste sortiert nach `expires_at` ASC
- `reserve(qty)` greift Batches in FEFO-Reihenfolge, nimmt aus mehreren wenn nötig
- Reservation merkt sich `(batch_id, qty)` damit Commit/Release exakt funktioniert
- `stock_movements` hat Kategorie-Enum (`receive`, `commit`, `release`, `adjust`,
  `breakage`, `shrinkage`, `quality_reject`, `expire_writedown`)
- Cron `fefo-recheck` schreibt täglich abgelaufene Bestände als `expire_writedown`
- Tenant-Setting `min_shelf_life_days` filtert Batches: Reservierungen verlangen
  Restlaufzeit ≥ Setting (Default 3 Tage)

## Execution Intent (Vibe)

- **Erweitert M08, ersetzt es nicht.** Stock-DO bleibt pro `(tenant, warehouse, sku)`,
  aber State wird strukturierter (Batches statt Single-Counter).
- **Atomar pro Reservation:** wenn 200 Stiele über 2 Batches gehen, beide
  Buchungen in einem DO-Step (DOs sind single-writer, das geht).
- **FEFO-Recheck als Cron** (M17), nicht beim Reservieren — sonst Latenz.
- **Bruch/Schwund** wird durch operative API geschrieben (`POST /stock/movements
  {category, qty, reason, batch_id}`).

## Inputs Required

- M08 (Stock-DO Basis-Implementation)
- M17 (Cron für fefo-recheck)
- M05 (Product-Schema mit `is_perishable: bool` + `default_shelf_life_days`)

## Deliverables

```
src/do/stock.ts (erweitert)            Batch-State, FEFO-Logik
migrations/00XX_perishability.sql      stock_batches, products.is_perishable, products.default_shelf_life_days, tenant.min_shelf_life_days
src/cron/jobs/fefo-recheck.ts
src/routes/stock-batches.ts            POST /stock/batches (Wareneingang mit MHD)
src/services/perishability.ts
tests/...
```

## Stock-DO erweiterter State

```ts
type StockState = {
  available_total: number;          // Σ aller Batch-qty - reservierte
  batches: {
    id: string;                      // ULID
    qty: number;
    received_at: string;
    expires_at: string;
    received_at_price_cents: number; // für COGS-Reporting
    supplier_batch_ref?: string;
  }[];
  reservations: Map<string, {
    qty_per_batch: { batch_id: string; qty: number }[];
    expires_at: string;
  }>;
};
```

## Happy Path (Reservation)

1. `reserve(qty=200, min_shelf_life_days=3)` kommt rein
2. DO filtert Batches mit `expires_at ≥ now + 3d`, sortiert ASC
3. Greift FEFO: ältester verfügbarer Batch zuerst
4. Wenn 200 nicht aus einem Batch: nächster Batch dazu
5. Wenn Σ < 200: `GH-STOCK-001` zurück
6. Sonst: Reservation mit `qty_per_batch[]` speichern

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Keine Batches mit ausreichender Restlaufzeit | `GH-FEFO-001` | 422 mit Detail (vorhandene Batches + ihre MHDs) |
| MHD bereits vergangen beim Reservieren | `GH-PERISH-001` | gefiltert, Batch ignoriert; FEFO-Recheck Cron schreibt es als writedown |

## Fallbacks

- Tenant kann `min_shelf_life_days = 0` setzen → alle nicht-abgelaufenen Batches
  zählen
- Pro-SKU-Override möglich (nicht-verderbliche SKUs umgehen FEFO komplett —
  `is_perishable: false`)

## Backwards-Compat Implications

- DO-State-Migration nötig: M08-State (Single-Counter) → M21-State (Batches).
  Migrations-Skript `do-state-v1-to-v2.ts` rollt einzelnen Counter in einen
  „Legacy"-Batch ohne MHD um.
- `stock_movements.category`-Enum permanent additiv

## Open Questions

- [x] ~~Default `min_shelf_life_days`?~~ → **3 Tage** (2026-04-28).
  Reason: typische Florist-Vertriebsdauer; Tenant überschreibbar.
- [x] ~~Wareneingang ohne MHD erlaubt?~~ → **Ja, mit Warning**, Batch bekommt
  `expires_at = received_at + product.default_shelf_life_days` (2026-04-28).

## Observability

- `stock.batch.expired_writedown_qty_per_day` (zu hoch = Operations-Problem)
- `stock.reserve.fefo_split_count` (zu viele Splits = Bestand zerstückelt)
- `stock.movement.category_distribution` (Bruch/Schwund-Anteil)

## Test Strategy

- FEFO-Korrektheit mit Synthetic-Batches
- Multi-Batch-Reserve atomar
- DO-State-Migrations-Test (Legacy → Batched)

## Learnings

→ `learnings/M21-perishability.log.md`

## Plan Revisions Originating Here

(initial leer)
