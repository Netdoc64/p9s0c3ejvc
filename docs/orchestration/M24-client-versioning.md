---
module_id: M24_client_versioning
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M24 — Client Versioning + Forced Upgrade

## Goal

Mobile- und MCP-Clients identifizieren ihre Version gegenüber dem Server.
Server kennt `min_supported_version` pro Plattform; ältere Clients erhalten
`426 Upgrade Required` mit Sunset-Header. Sanfte Migration: Push-Notification
zur neuen Version vor Hard-Cutoff.

## Non-Goals

- Keine Auto-Update-Distribution (Store macht das)
- Keine A/B-Testing-Infrastruktur (separate Sache)

## Success Criteria

- Pflicht-Header `X-Client-Version` und `X-Client-Platform` auf jeder Customer-API-Request
- Fehlt der Header → 400 (für Mobile-Routes — B2B-API ohne Header läuft)
- Version < `min_supported_version` → 426 mit human-readable Body + Store-Link
- Sunset-Datum 30 Tage vor Hard-Cutoff via Push notification angekündigt
- Telemetrie: Version-Verteilung pro Tenant beobachtbar

## Execution Intent (Vibe)

- **SemVer für Clients:** `1.4.2` etc. Vergleich semantisch.
- **Pro Plattform separate Mindestversion**: iOS und Android können unabhängig
  cuten.
- **Soft-Sunset 30d** vor Hard-Cutoff: Server gibt Warning-Header zurück,
  Mobile-App kann darauf reagieren.

## Inputs Required

- M02 (Middleware-Pipeline)
- M23 (Push für Sunset-Notification)
- Cross-Cutting `client_versioning`

## Deliverables

```
src/middleware/client-version.ts       parsed Header, vergleicht gegen Config
migrations/00XX_client_min_versions.sql client_min_versions (platform, version, sunset_at, since)
src/routes/admin/client-versions.ts    POST /admin/client-versions (Operator-API)
src/services/version-cmp.ts            SemVer-Vergleich
src/cron/jobs/client-sunset-notify.ts  schickt Push 30d vor Sunset
tests/...
```

## Happy Path

1. Mobile-Request kommt mit `X-Client-Version: 1.4.2, X-Client-Platform: ios`
2. Middleware lädt aktuelle `min_supported_version` für Platform aus KV-Cache
3. Wenn Version ≥ min: weiter; Header `X-Client-Status: ok`
4. Wenn Version < min UND Sunset-Datum > now: Header `X-Client-Status: deprecated`,
   Body wird zugestellt, Mobile-App soll Upgrade-Hint zeigen
5. Wenn Version < min UND Sunset erreicht: 426 + JSON `{store_link_ios, store_link_android, message}`

## Error Paths

| Symptom                              | Code             | Recovery |
|--------------------------------------|------------------|----------|
| Version-Header fehlt auf Mobile-Route| `GH-CLIENT-001`  | 400, klare Error-Message |
| Version unbekannt (z.B. „latest")    | `GH-CLIENT-001`  | 400 |
| Version unter min                    | `GH-CLIENT-001`  | 426 |

## Fallbacks

- Plattform unbekannt (z.B. neue „web") → akzeptieren wenn `X-Client-Platform`
  gesetzt aber nicht in `client_min_versions`. Telemetry wirft Warning.
- KV-Down beim Min-Version-Lookup → fail-open mit Worst-Case (lasse alles durch),
  Alert.

## Backwards-Compat Implications

- Header-Namen permanent
- 426-Response-Body-Schema additiv erweiterbar
- Sunset-Lifecycle (30d Warning + Hard-Cutoff) Tenant-konfigurierbar, Default permanent

## Open Questions

- [x] ~~SemVer-Vergleich oder Build-Number?~~ → **SemVer** (2026-04-28).
  Reason: Mobile-Stores nutzen das, Operator-konzeptionell einfacher.
- [x] ~~Soft-Sunset-Window?~~ → **30 Tage** (2026-04-28). Reason: Genug für
  App-Store-Review-Zyklen + User-Update-Träge.

## Observability

- Gauge `client.version_distribution` pro Platform (Operator-Dashboard)
- Counter `client.upgrade_required` (sollte 0 unter Hard-Cutoff sein)
- Counter `client.deprecated_warned` (Indikator für Migrations-Druck)

## Test Strategy

- Header-Parsing-Tests (alle Edge-Cases: missing, malformed, „latest")
- SemVer-Vergleich-Tests (1.4.2 vs 1.4.10, 2.0.0-beta1 vs 2.0.0)
- Sunset-Boundary-Tests (1ms vor/nach Sunset)
- Cron-Notify-Test: 30d-vor-Sunset triggert Push

## Learnings

→ `learnings/M24-client-versioning.log.md`

## Plan Revisions Originating Here

(initial leer)
