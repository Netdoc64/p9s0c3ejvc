# M18 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7 (build run #1)

### What happened
PII-Redaction-Helper, Metrics-Wrapper (counter/histogram/gauge), 5 SLO-Definitionen als Code, Logger erweitert um PII-Strip + Metric-Emission, `monitoring/alerts.json` + 2 Dashboards (`api`, `tenant-health`), 7 Runbooks (api-availability, p99-latency, stock-reserve-latency, webhook-delivery-lag, auth-failure-spike, cron-job-paused, kv-unavailable).

### Decisions
1. **PII via Field-Pattern statt Zod-Annotations**: Zod-`.describe("pii")` würde funktionieren, aber Pattern-Liste ist einfacher zu warten und greift auch auf raw-Objects (nicht nur Zod-validated). Erweiterbar via `PII_KEY_PATTERNS`.
2. **Metrics emittiert via `console.log({event: "metric", ...})`**: Kein nativer Metric-Sink in v1. Logpush zieht sie nach R2; Workers Analytics Engine ist Plan-Revision-Kandidat sobald CF das natürlicher unterstützt.
3. **Forbidden Label Keys**: `customer_id`, `order_id`, `request_id`, `email` sind explizit verboten als Metric-Labels (Cardinality-Schutz). Sie bleiben aber im Log-Body verfügbar.
4. **Burn-Rate Critical = 14.4**: Standard-Multiplikator (Google SRE-Buch). Bei 99.9% SLO entspricht das 30d-Errorbudget in 2h aufgebraucht.
5. **Runbooks pro Alert** statt einem einzigen Doc — schneller im Incident.
6. **Logger-Output enthält jetzt automatisch PII-Hash**: jeder Log durchläuft `redactPii` vor `JSON.stringify`. Test-Log-Output ist sichtbar PII-frei.

### Tests
- pii.spec: 5 Tests (key-matcher, top-level, nested, deterministic, arrays)
- slos.spec: 3 Tests (Vollständigkeit, target, burn-rate-Schwellen)

### Confidence
high — PII-Test belegt automatische Redaction; SLO-Definitionen sind im Code = Single-Source-of-Truth.

### Bewusst nicht in v1
- **Logpush-Konfig**: muss via CF-Dashboard / API konfiguriert werden (nicht in `wrangler.toml` deklarierbar). Wird beim Deploy als Setup-Schritt dokumentiert.
- **Synthetic-Latenz-Test (SLO-Compliance-Suite)**: setzt deployed Environment voraus. Plan-Revision wenn CI-Schritt eingeführt wird.

### Follow-ups
- M11 ergänzt `histogram("orders.create.duration_ms", ...)` und `gauge("orders.gauge", count, {state})`.
- M08 ergänzt `histogram("stock.reserve.duration_ms", ..., {tenant: hash})`.
- M12 ergänzt `gauge("outbox.lag_seconds", maxAge)`.
