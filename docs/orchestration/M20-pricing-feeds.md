---
module_id: M20_pricing_feeds
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P3_orders
---

# M20 — Pricing Feeds (Auktionspreise)

## Goal

Tägliche automatische Aufnahme von Aalsmeer-/RBC-Auktionspreisen in die
Pricing-Engine, sodass Pilot-Bestellungen die aktuelle Marktlage
reflektieren — ohne manuelle Listenpflege.

## Non-Goals

- Kein Live-Auktion-Bidding (wir konsumieren Tagespreise post-auction, nicht in Echtzeit)
- Keine Spot-Preisbörse (nur Tagesschluss)
- Keine cross-tenant Preis-Aggregation (jeder Tenant hat eigenen Feed)

## Success Criteria

- Daily-Cron pulled Feed pro konfiguriertem Tenant ≤ 09:00 Europe/Amsterdam
- Erfolgreich geladene Preise erzeugen neue `price_list`-Version mit
  `valid_from = today`, `valid_to = tomorrow 23:59`
- Alte Liste wird automatisch `valid_to = today 09:00` (nahtlose Cutover)
- Bei Feed-Down: letzte gültige Liste bleibt aktiv mit Warning + Alert
- Preisänderung >50% gegenüber Vortag → manuelle Bestätigung erforderlich
  (Schutz gegen kaputte Feeds)

## Execution Intent (Vibe)

- **Adapter-Pattern pro Quelle.** Aalsmeer FloraHolland, RBC, Plantion — jede
  hat eigenen Adapter, gleiche Output-Form (`{ sku_code, price_cents, currency, basis_unit }`).
- **Feed-Mapping fehlertolerant:** SKU-Code-Resolution mit Fuzzy-Match-Fallback,
  unbekannte Codes werden geloggt aber nicht blockierend.
- **Atomarer Cutover:** neue Liste komplett geladen, dann ein UPDATE switcht
  `current_list_id`. Kein Halbstand.

## Inputs Required

- M06 (Pricing-Engine + price_list-Schema)
- M17 (Cron-Worker)
- Pro Tenant: Feed-Konfiguration (Adapter-ID + URL/Credentials)

## Deliverables

```
src/services/pricing-feeds/
  registry.ts                          Adapter-Liste
  adapter.aalsmeer.ts                  Aalsmeer FloraHolland
  adapter.rbc.ts                       RBC
  adapter.csv-generic.ts               für Tenants ohne offizielle API
  resolver.ts                          Feed-Row → SKU mapping
src/cron/jobs/pricing-feed-pull.ts     (Hook in M17)
migrations/00XX_pricing_feeds.sql      tenant_pricing_feeds, feed_runs
src/routes/pricing-feeds.ts            POST /pricing-feeds/test (manueller Trigger)
tests/services/pricing-feeds/...
```

## Happy Path

1. Cron 09:00 Europe/Amsterdam triggert `pricing-feed-pull`
2. Pro Tenant mit konfiguriertem Feed: Adapter holt Daten
3. Resolver mappt Feed-SKU-Codes auf interne `sku_id`
4. Anomalie-Check: Preis-Drift gegen Vortag pro SKU
5. Wenn alle ok: neue `price_list_xxxx_yyyy_mm_dd` erzeugt mit den Items
6. Atomarer Switch: `current_list_id` zeigt auf neue Liste
7. Audit-Eintrag in `feed_runs`

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Feed-Endpoint unerreichbar           | `GH-FEED-001`    | letzte Liste aktiv lassen + Alert |
| Feed-Format invalid                  | `GH-FEED-002`    | Run abbrechen, Alert; alte Liste bleibt |
| >50% Preis-Drift auf >5% der SKUs    | `GH-FEED-002`    | Auto-Switch blockiert, manuelle Freigabe |
| SKU-Code unbekannt                   | (Warning-Log)    | übersprungen, in `feed_runs.unmatched_skus` |

## Fallbacks

- Feed dauerhaft tot → letzte Liste bleibt aktiv (mit täglich eskalierendem Alert)
- Manueller CSV-Import als Fallback (Operator lädt Excel hoch via UI/API)

## Backwards-Compat Implications

- Adapter-IDs permanent
- Feed-Run-Audit append-only
- Output-Schema (sku_code, price_cents, …) versionsiert pro Adapter

## Open Questions

- [x] ~~Drift-Schwellwert?~~ → **>50% Preis-Drift auf >5% der SKUs** (2026-04-28).
  Reason: tagsüber 30%-Schwankungen sind in Blumen normal (Saison, Wetter),
  >50% deutet auf Feed-Bug. 5% Stichprobengrösse robust.
- [x] ~~Welche Feeds für Pilot?~~ → **Aalsmeer FloraHolland (Adapter A) + CSV-
  Generic** (2026-04-28). Reason: der Pilot sitzt in Aalsmeer; CSV-Generic
  als Fallback für Tenants ohne API-Zugang.

## Observability

- `feed.run.success/failed` pro Tenant pro Adapter
- `feed.unmatched_sku_count` (Trend zeigt SKU-Mapping-Lücken)
- `feed.price_drift_p99` (Sanity-Check)

## Test Strategy

- Adapter-Unit-Tests gegen Fixture-Files
- Drift-Detection-Test mit synthetischem Feed
- Cutover-Atomarität: parallel zur Switch-Operation laufende Order bekommt
  konsistente Liste

## Learnings

→ `learnings/M20-pricing-feeds.log.md`

## Plan Revisions Originating Here

(initial leer)
