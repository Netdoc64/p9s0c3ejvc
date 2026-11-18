# M20 — Learnings

### What happened
`tenant_pricing_feeds` + `feed_runs` Schema, `csv-generic`-Adapter (HTTP-CSV → SKU+Preis-Rows), `runFeed`-Service mit Drift-Detection (>50% Preisänderung auf >5% SKUs blockt Switch), Cron `pricing-feed-pull` (daily 05:00).

### Decisions
1. **Nur `csv-generic`-Adapter in v1**. `aalsmeer` und `rbc` sind Plan-Revision-Kandidaten — Spec-Format-Reverse-Engineering kann iterativ erfolgen, sobald Pilot-Tenant Daten liefert.
2. **Atomarer Cutover**: neue `price_list` mit `is_default=1`, alte auf `is_default=0`. Nicht echt-atomar in D1 (zwei UPDATEs); Plan-Revision-Kandidat: in eine Tx packen.
3. **Drift = Preisabweichung > drift_threshold_pct (50%) auf > drift_skus_pct (5%) der vergleichbaren SKUs** → block. Konservativer Default.
4. **POST /pricing-feeds/test** (manueller Trigger) ist Plan-Revision-Kandidat — Cron + DB-Insert reicht für Pilot.
