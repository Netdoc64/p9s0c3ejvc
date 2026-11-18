# Runbook — Webhook Delivery Lag

**SLO:** 99% delivered within 1h (`webhook_delivery_within_1h`)

## Trigger

`max(outbox.lag_seconds over 5m) > 3600`

## Schritte

1. `outbox_events` nach `status` aggregieren — wieviele `pending` sind älter als 1h?
2. Welche Tenants? Welche Topics?
3. Delivery-Logs des Workers (`webhook-deliverer`) checken:
   - Receiver-5xx-Rate hoch? → Tenant-Receiver-Issue, kein Plattform-Issue
   - Consumer crashed? → Logs, Restart durch Re-Deploy
4. Cron-Sweeper (`outbox-sweep`) läuft? `cron_runs WHERE job_id='outbox-sweep'`.

## Sofortmassnahme

- Manueller Sweep: `wrangler d1 execute DB --command "UPDATE outbox_events SET status='pending', retry_at=NULL WHERE status='retrying' AND created_at < datetime('now','-1 hour')"`
- Falls Receiver ein Tenant-Issue → Tenant kontaktieren, ggf. Subscription deaktivieren

## Nach dem Incident

- Backoff-Konfig prüfen, ob die 1s..6h-Sequenz noch passt
