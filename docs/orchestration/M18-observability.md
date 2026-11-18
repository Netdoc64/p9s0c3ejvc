---
module_id: M18_observability
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P1_foundation
---

# M18 — Observability + SLOs

## Goal

Strukturierte Logs (mit PII-Redaction), Metriken (Counter/Histogram/Gauge),
Alerting-Regeln, dokumentierte SLOs/SLAs als Anker für Monitoring und Incident-Response.

## Non-Goals

- Kein eigenes Tracing-System (CF-Trace-Header reichen v1; OpenTelemetry-Export
  kommt als Plan-Revision wenn nötig)
- Keine APM-Integration mit Drittanbietern in v1

## Success Criteria

- Jede Route emittiert Log mit Pflichtfeldern (request_id, tenant_id, customer_id?,
  route, status, duration_ms)
- PII-Redaction läuft automatisch via Field-Tagging in Zod (annotate `.pii()` →
  Logger ersetzt durch Hash)
- SLO-Dokumentation in diesem File ist verbindlich (Alerts kalibriert daran)
- Logpush nach R2 aktiviert (Audit-Aufbewahrung)
- Dashboard-Definitionen als Code (`monitoring/dashboards/*.json`)

## Execution Intent (Vibe)

- **Logs sind strukturiertes JSON, nichts anderes.** Kein `console.log("text")`.
- **Cardinalities niedrig halten:** keine `customer_id` als Metrik-Label (zu hoch),
  nur als Log-Feld.
- **SLOs sind Vertrag**, nicht Aspiration. Wenn wir 99.9% versprechen, alarmiert
  Errorbudget bei 0.1%-Überschreitung über 30d-Window.

## Inputs Required

- M02 (Logger-Middleware)
- Cross-Cutting `slo`, `pii_redaction` (siehe build-plan)

## Deliverables

```
src/observability/
  pii.ts                               Field-Tagging-Helper (Zod-Erweiterung)
  metrics.ts                           Counter/Histogram/Gauge-Wrapper
  slos.ts                              SLO-Definitionen als Code
src/middleware/logger.ts (erweitert)   PII-Redaction beim Serialisieren
monitoring/
  alerts.json                          Alert-Definitionen
  dashboards/api.json                  CF-Dashboard-Export
  dashboards/tenant-health.json
docs/runbooks/                         Incident-Runbooks pro SLO-Verletzung
```

## SLO-Definitionen (verbindlich)

| Bereich            | SLI                                            | SLO       |
|--------------------|------------------------------------------------|-----------|
| API Availability   | erfolgreiche Requests / total                  | 99.9%/30d |
| API Latency p99    | duration_ms < 500 für /v1/orders/* hot-path    | 99%/30d   |
| Webhook Delivery   | events delivered ≤ 1h nach state-change         | 99%/30d   |
| Auth Latency p99   | < 200ms                                        | 99%/30d   |
| Stock-DO Reservation p99 | < 100ms                                  | 99%/30d   |

Errorbudget pro SLO: 100% - SLO_target. Bei 50% Verbrauch → Warning, 100% → Freeze.

## Happy Path

1. Request kommt rein; Logger generiert `request_id`
2. Hono-Middleware misst duration, schreibt strukturiertes Log am Ende
3. PII-Felder (Email, Telefon, Name) werden im Logger durch
   `<sha256:1234567>`-Tag ersetzt
4. Metrik-Emitter sendet Counter („request"), Histogram („duration_ms")
5. Logpush sammelt Logs nach R2 (30d Aufbewahrung default)

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Logpush-Sink unerreichbar            | `GH-OBS-001`     | Fail-open + Worker-Logs als Backup |
| PII-Redaction-Bug (PII leakt)        | (kein Code, Pflichtbug) | Fix immediate, Log-Replay-Cleanup |

## Fallbacks

- Logpush-Down → Worker-Logs (CF-built-in 14d) bleiben aktiv
- Metric-Sink-Down → in-memory Aggregat, retry beim nächsten Heartbeat

## Backwards-Compat Implications

- SLO-Definitionen können **strenger** werden (Plan-Revision-additiv), niemals
  schwächer ohne explizite Begründung
- Pflicht-Log-Felder permanent

## Open Questions

- [x] ~~Tracing v1?~~ → **Nein, CF-Trace-Header reichen** (2026-04-28).
  OpenTelemetry-Export Plan-Revision wenn Multi-Service-Tracing nötig.
- [x] ~~Logpush-Aufbewahrung?~~ → **30 Tage default in R2, 7 Jahre in
  Cold-Archive für Audit-Logs** (2026-04-28). Compliance-Pflicht für
  Bestelldaten.

## Observability (rekursiv)

- Logpush-Lag-Sekunden
- Metric-Emit-Failure-Rate
- PII-Redaction-Cache-Hit-Rate

## Test Strategy

- PII-Redaction-Test: Email im Body → Hash im Log
- SLO-Compliance-Suite: Lasttest gegen API, prüft Latenz-Verteilung
- Alert-Routing-Test: künstlicher Failure → Alert kommt an

## Learnings

→ `learnings/M18-observability.log.md`

## Plan Revisions Originating Here

(initial leer)
