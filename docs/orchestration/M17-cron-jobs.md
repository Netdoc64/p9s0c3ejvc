---
module_id: M17_cron_jobs
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P1_foundation
---

# M17 — Cron Jobs / Scheduled Worker

## Goal

Zentraler Scheduled-Worker, der alle wiederkehrenden Tasks fährt: Outbox-Sweeper,
TTL-Cleanups, Tagesreports, Stock-Alerts, Secret-Rotations-Trigger, VIES-Cache-Refresh,
FEFO-Recheck, Pricing-Feed-Pull.

## Non-Goals

- Kein generisches Scheduling-Framework (Tenant-Operator-konfigurierbare Cron-Jobs
  → Plan-Revision wenn relevant)
- Keine Long-Running-Jobs (CF-Worker-CPU-Limit beachten — Splits via Queue)

## Success Criteria

- Single `wrangler.toml`-Trigger-Block listet alle Cron-Schedules
- Job-Registry: jeder Job hat `id`, `cron`, `handler`, `idempotency_key_prefix`
- Job-Run schreibt `cron_runs`-Tabelle (Erfolg/Fehler/Dauer) für Audit
- Job-Failure → Alert, Retry beim nächsten Trigger
- Long-Tasks (Split): erste Run schreibt Work-Items in Queue, Queue-Consumer arbeitet ab

## Execution Intent (Vibe)

- **Eine Funktion = ein Job.** Kein „mehrere Sachen in einer Cron-Run-Function".
- **Idempotenz Pflicht:** jeder Job ist sicher, mehrfach gestartet zu werden
  (Job-Lock via DO oder D1-Row-Lock).
- **Strikt strukturierte Logs** mit `job_id`, `run_id`, `tenant_id` (falls per-Tenant).
- **Job-Granularität fein:** lieber 12 Jobs als 3 mega-Jobs mit if-Verzweigung.

## Inputs Required

- M01 (Skeleton + Cron-Trigger im wrangler.toml)
- M02 (Logger — Cron-Logs gehen durch denselben Sink)

## Deliverables

```
src/cron/
  index.ts                             scheduled() Entry, dispatched auf Job-ID
  registry.ts                          Liste aller Jobs
  jobs/
    outbox-sweep.ts                    holt liegen gebliebene Outbox-Events
    ttl-cleanup.ts                     Idempotency-Cache, Magic-Link-Codes, Auth-Codes
    secret-rotation.ts                 90-Tage-Trigger
    vies-cache-refresh.ts              proaktives Re-Validate vor Ablauf
    daily-report.ts                    pro Tenant Tagessumme → Email
    stock-low-alert.ts                 Schwellwert-Unterschreitung → Webhook
    fefo-recheck.ts                    abgelaufene Batches → write-down
    pricing-feed-pull.ts               (M20-Hook)
migrations/00XX_cron_runs.sql          cron_runs (Audit)
tests/cron/...
```

## Happy Path

1. CF-Cron-Trigger feuert → Worker `scheduled()` läuft
2. Dispatch: cron-Pattern → Job-ID
3. Job nimmt Lock (DO oder Row-Lock), läuft, releast
4. Schreibt `cron_runs` mit Dauer/Status

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Job-Lock hängt (vorheriger Run crashed)| `GH-CRON-001`  | Lock mit TTL — alter Lock auto-released |
| Job-Handler wirft                    | `GH-CRON-001`    | Alert, nächster Trigger versucht erneut |
| Cron-Trigger-Konfig falsch           | (Setup-Bug)      | wrangler-Validation in CI |

## Fallbacks

- Wenn ein Job-Job dauerhaft scheitert: Alert eskaliert nach 3 Failures, Job
  wird `paused: true` markiert (manueller Resume nötig). Vermeidet Storm.

## Backwards-Compat Implications

- Job-IDs permanent
- `cron_runs`-Tabelle append-only
- Zeitplan-Änderungen (cron-Expression) ja erlaubt, müssen aber dokumentiert sein

## Open Questions

- [x] ~~Job-Lock via DO oder D1?~~ → **DO mit TTL** (2026-04-28). Reason: atomar,
  TTL-Auto-Release, kein D1-Row-Locking-Workaround.
- [x] ~~Wie oft Outbox-Sweep?~~ → **Jede Minute** (2026-04-28). Schmal genug
  dass Backlog klein bleibt.

## Observability

- Counter `cron.run.success/failed` pro Job-ID
- Histogram `cron.run.duration_ms`
- Gauge `cron.job.paused` (sollte 0 sein im Normalbetrieb)

## Test Strategy

- Job-Idempotenz: zweimal laufen lassen, gleicher Side-Effect
- Lock-TTL: Crash mid-job → nächster Trigger nimmt Lock nach TTL
- Job-Pause-Mechanik nach 3 Failures

## Learnings

→ `learnings/M17-cron-jobs.log.md`

## Plan Revisions Originating Here

(initial leer)
