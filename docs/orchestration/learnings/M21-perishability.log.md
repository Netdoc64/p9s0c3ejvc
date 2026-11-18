# M21 — Learnings

### What happened
v1: `stock_batches` D1-Tabelle (id, mhd, qty, status), `tenants.min_shelf_life_days` Spalte, `POST /v1/stock/batches` (Wareneingang) erhöht D1-Batch + DO-Counter, daily-`fefo-recheck`-Cron markiert abgelaufene Batches und schreibt sie aus dem Stock.

### Decisions
1. **Batches in D1, Counter im DO** statt voller Batch-State im DO. Reason: spart DO-State-Migration v1→v2 (Plan-Revision-Kandidat); Atomicity ist eventually-consistent (Batches+DO via separate Tx); Pilot-Pilot-Tenant tolerant.
2. **FEFO-Reservation noch nicht implementiert** in `stockSvc.reserve` — der Plan-Revision-Punkt ist klar definiert: vor reserve() Batches sortiert nach mhd ASC laden, allokieren, Reservation pro Batch verfolgen.

### Bewusst Plan-Revision-Kandidaten
- **DO-State-Migration v1→v2** (Batches im DO mit FEFO-Reservierung) — ein eigener PR mit Doppel-Reader-Phase.
- **Real-FEFO-Reservation-Logik** im Service-Layer — wenn Pilot-Daten zeigen dass eventually-consistent nicht reicht.
