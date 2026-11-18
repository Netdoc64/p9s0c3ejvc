# Runbook — Cron Job Paused

**Trigger:** ein Job in `cron_job_state` ist `paused=1`. M17 pausiert nach 3 consecutive failures automatisch.

## Schritte

1. `SELECT * FROM cron_runs WHERE job_id=? ORDER BY started_at DESC LIMIT 5` — letzte Failures lesen.
2. `error_code` + `error_detail` analysieren.
3. Ursache fixen (Modul-Code-Bug, externe API down, Schema-Migration nötig?).
4. Manueller Resume:
   - via CLI: `pnpm tsx scripts/cron-resume.ts <job_id>` (sobald M17-CLI-Erweiterung gebaut)
   - via SQL (interim): `UPDATE cron_job_state SET paused=0, consecutive_failures=0 WHERE job_id=?`
5. Wenn Job direkt wieder failed: nicht erneut resumen — Plan-Revision für Job-Implementation.

## Eskalation

- Outbox-Sweeper paused > 30min → Webhook-Delivery-Lag-Risiko, höher priorisieren.
- VIES-Refresh paused > 2h → keine Sofort-Massnahme, Cache reicht 24h.
