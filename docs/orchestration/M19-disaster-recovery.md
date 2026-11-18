---
module_id: M19_disaster_recovery
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P5_hardening
---

# M19 — Disaster Recovery + Backup-Strategie

## Goal

Wiederherstellbarkeit der App nach Region-Ausfall, korrupter Migration oder
operativem Fehler — mit dokumentierten RTO/RPO-Zielen, getesteten Restore-Skripten
und einem jährlichen Drill.

## Non-Goals

- Kein Multi-Region-Active-Active-Setup (CF macht Read-Replikation transparent;
  Schreibregion-Failover ist Ausnahmefall)
- Kein Real-Time-Replikat zu externem Provider

## Success Criteria

- **RTO** (Recovery Time Objective) ≤ 4h
- **RPO** (Recovery Point Objective) ≤ 1h
- Daily D1-Export nach R2 (zusätzlich zu CF-Time-Travel)
- DO-Snapshot-Skript pro Tenant (manuelle Trigger)
- Dokumentierter Restore-Runbook in `docs/runbooks/disaster-restore.md`
- Jährlicher DR-Drill auf Staging mit nachweislichem Erfolg

## Execution Intent (Vibe)

- **Backup ist nutzlos ohne getesteten Restore.** Drill muss laufen.
- **Multi-Layer-Redundanz:** CF-Time-Travel (D1-eigene 30d-Recovery) + täglicher
  R2-Export (langfristig) + Logpush-Audit (Eventreplay).
- **DOs sind das schwierigste:** kein eingebauter Backup. Snapshot-Skript exportiert
  via DO-eigene Methode (ein `dump()`-RPC pro DO).

## Inputs Required

- Alle Daten-relevanten Module (M03, M04, M05, M08, M09, M12)
- M17 (Cron für Daily-Export)
- M18 (Observability — Drill-Logs)

## Deliverables

```
scripts/
  backup-d1-daily.ts                   Cron, exportiert D1 nach R2
  backup-do-stock.ts                   manuelle DO-Snapshots
  restore-d1-from-r2.ts                Restore-Skript
  restore-do-stock.ts
docs/runbooks/
  disaster-restore.md                  Schritt-für-Schritt
  partial-data-loss.md                 für Teil-Ausfälle
.github/workflows/dr-drill.yml         jährlicher automatischer Drill
```

## Daten-Backup-Matrix

| Layer       | Backup-Mechanismus                               | RPO    | Restore-Pfad          |
|-------------|--------------------------------------------------|--------|-----------------------|
| D1 (orders, customers, products, …) | CF Time-Travel (30d) + Daily R2-SQL-Dump | 1h | wrangler d1 restore   |
| DO (stock)  | DO-eigene `dump()`-RPC, manuell + nach Migration | 24h    | DO-`restore()`-RPC    |
| KV (cache)  | Regenerierbar — kein Backup                      | n/a    | Cold-Cache ist OK     |
| R2 (assets, invoices) | Versioning + Cross-Region-Replikation  | 1h     | R2 hat eigene Recovery|

## Happy Path (Daily Backup)

1. Cron 02:00 UTC triggert `backup-d1-daily.ts`
2. Worker führt `wrangler d1 export --output=...` aus, lädt nach R2
3. Schreibt `backup_runs` in eigene Tabelle mit Hash + Size
4. Verify-Job (Phase 2) liest Backup, prüft Integrity-Hash

## Restore-Pfad (DR)

Siehe `docs/runbooks/disaster-restore.md`. Vereinfacht:

1. Incident festgestellt → Owner-Rolle übernimmt
2. R2-Backup auswählen (jüngstes intaktes vor Incident)
3. Auf Staging restoren, Smoke-Test
4. Wenn Smoke grün → Prod-Restore mit Cutover-Plan
5. Outbox-Replay aus Logpush für die Lücke RPO→Cutover

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Daily-Backup fehlgeschlagen          | `GH-DR-001`      | Alert, manueller Trigger |
| Backup-Integrity-Hash mismatch       | `GH-DR-001`      | Alert, vorheriges Backup nutzen |
| Restore-Drill fail                   | (im CI sichtbar) | Runbook fixen |

## Fallbacks

- Wenn R2-Backup beschädigt: CF-Time-Travel (30d) als Plan B
- Wenn beide tot: Logpush-Replay aus 7-Jahres-Cold-Archive (langsam, aber
  möglich für Audit-relevante Daten)

## Backwards-Compat Implications

- Backup-Format-Versionierung: SQL-Dump trägt `schema_version` im Filename
- Restore-Skripte versionsiert mit Schema (M19/v1 restored auf
  build-plan/1.x-Schema)

## Open Questions

- [x] ~~Backup-Region?~~ → **R2 in `weur` + Cross-Region-Replikation nach
  `enam`** (2026-04-28). Schutz gegen Regional-Outage.
- [x] ~~RTO/RPO-Ziele?~~ → **RTO 4h, RPO 1h** (2026-04-28). Realistisch für
  CF-Stack ohne Multi-Region-Active-Active.

## Observability

- `backup.daily.success`-Counter
- `backup.size_mb`-Gauge (Trend)
- `dr_drill.last_success_at`-Timestamp (Alert wenn >365d alt)

## Test Strategy

- DR-Drill jährlich auf Staging — komplett restoren, Smoke-Test laufen lassen
- Backup-Integrity-Test täglich (Hash-Verify)
- Runbook-Walkthrough mit Junior-Engineer (Lesbarkeit)

## Learnings

→ `learnings/M19-disaster-recovery.log.md`

## Plan Revisions Originating Here

(initial leer)
