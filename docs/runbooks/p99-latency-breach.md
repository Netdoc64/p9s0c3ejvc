# Runbook — p99 Latency Breach

**SLO:** p99 < 500ms für `/v1/orders/*` (`api_p99_latency`)

## Trigger

`p99(duration_ms over 30m for /v1/orders/*) > 500`

## Erste Schritte

1. Welche Sub-Route ist betroffen? Drill-Down im Dashboard.
2. Korrelation mit Stock-DO-Latenz (`stock.reserve.duration_ms`)?
3. Korrelation mit DB-Query-Plans (langsame `findById` o.ä.)?

## Häufige Ursachen

- **Kalter D1-Region-Roundtrip:** Region-Replikation prüfen (`weur`).
- **Stock-DO-Hotspot:** ein Tenant/SKU mit zu viel Concurrency. Plan-Revision-Kandidat: Sub-DOs.
- **Drizzle-N+1:** unbeabsichtigte zusätzliche Queries. Tracing einschalten, joins prüfen.

## Sofortmassnahme bei akut

- Nicht-kritische Background-Jobs pausieren (`cron_job_state.paused=1`)
- Tenant-Quota schärfen (M15) für betroffenen Tenant

## Nach dem Incident

- Falls Wiederholung: ggf. Cache-Layer (KV) für hot-Query erwägen.
