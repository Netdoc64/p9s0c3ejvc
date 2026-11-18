# Runbook — API Availability Burn

**SLO:** 99.9% / 30d (`api_availability_30d`)

## Trigger

`burn_rate(1h) > 14.4` (critical) — bei dieser Rate ist das 30d-Errorbudget in
~2h aufgebraucht. **Sofort handeln.**

## Erste 5 Minuten

1. Dashboard `monitoring/dashboards/api.json` öffnen
2. Welche Routes sind betroffen? (Filter: `error_code != ''`, group by route)
3. Welche `error_code`-Werte dominieren?

## Triage anhand error_code

| Code               | Vermutliche Ursache                          | Erste Aktion |
|--------------------|----------------------------------------------|--------------|
| `GH-INFRA-001`     | D1/KV/R2/Queue unerreichbar                  | CF-Status checken; falls einzelner Service: Logs nach Region |
| `GH-INFRA-002`     | Unerwartete Exception                        | Stack-Trace im Log → Hotfix-Branch |
| `GH-AUTH-*` Spike  | DDoS oder Tenant-Bug                         | Per-Tenant filtern, ggf. Rate-Limit anziehen |
| `GH-STOCK-003`     | DurableObject-Region-Issue                   | Stock-DO-Migration prüfen (M19 DR-Drill) |

## Eskalation

- Wenn Ursache nicht in 15min identifiziert → Page Tech-Lead
- Bei externer Abhängigkeit (z.B. CF-Outage) → Statusseite updaten

## Nach dem Incident

- Postmortem in `docs/postmortems/<DATE>-<INCIDENT>.md`
- Plan-Revision wenn ein Modul-Spec Lücke aufweist
