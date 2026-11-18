---
module_id: M00_template
status: stub
version: 0.0
last_updated: 2026-04-28
---

# M00 — Template

> **Wie diese Datei zu nutzen ist:**
> Kopiere diese Datei nach `M<NN>-<short-name>.md`. Setze `module_id` und `status`
> im Front-Matter. Fülle alle Sektionen. Lass keine Sektion leer — wenn nicht
> zutreffend, schreib „n/a — Begründung". Stub-Sektionen sind erlaubt, müssen
> aber `TBD`-Marker tragen.

## Goal

Ein Satz, geschäftlich/funktional. Keine Implementation, keine Technologie.

> Beispiel: „Verlässliche, atomare Bestandsführung pro SKU mit Reservierungs-TTL,
> sodass parallele Bestellungen nicht überverkaufen."

## Non-Goals

Bullet-Liste, was dieses Modul **explizit nicht** löst. Schützt vor
Scope-Creep.

> Beispiel:
> - Inventur-UI (kommt später, eigenes Modul)
> - Multi-Warehouse-Auto-Routing (deferred)

## Success Criteria

Messbar. Wenn du es nicht testen kannst, ist es kein Kriterium.

> Beispiel:
> - 100 parallele `reserve(1)` auf Bestand=50 → genau 50 success, 50 ×
>   `GH-STOCK-001`
> - TTL-Reservation ist nach Ablauf in `available` zurück
> - Jede Mutation hat einen Eintrag in `stock_movements`

## Execution Intent (Vibe)

Wie soll der Agent das angehen? Spielraum statt Mikromanagement. 3–5 Bullets.

> Beispiel:
> - Bottom-up: erst die DO-Klasse mit Tests im Vakuum, dann Anbindung an Repo.
> - Stress-Test ist Pflicht, nicht Bonus.
> - Das Modul ist klein und kritisch — eher konservativ, eher viele Tests.

## Inputs Required

Was muss vor Build-Start vorhanden sein? Verweise auf andere Module / Specs.

- Build-Plan-Knoten: [`build-plan.json#modules.M<NN>`](../build-plan.md)
- Abhängigkeiten: siehe `depends_on` im Plan-Knoten
- Externe Specs: …

## Deliverables (Outputs)

Konkrete Artefakte. Pfade, Datei-Endungen.

- `src/...` — TypeScript-Module
- `migrations/<NNNN>_<name>.sql` — D1-Migration
- `tests/...` — Vitest-Spezifikationen
- (ggf.) Updates an `_errors.md` falls neuer Fehlercode benötigt

## Happy Path

Schritt-für-Schritt, was bei Erfolg passiert. Imperative Form.

1. …
2. …
3. …

## Error Paths

Tabelle mit Symptom → Code aus `_errors.md` → Recovery.

| Symptom                              | Code             | Recovery                |
|--------------------------------------|------------------|-------------------------|
| (TBD)                                | (TBD)            | (TBD)                   |

**Wichtig:** Kein Code wird hier *erfunden*. Wenn der passende fehlt → erst in
`_errors.md` registrieren.

## Fallbacks

Was, wenn der Happy Path nicht möglich ist?

> Beispiel: „Wenn DO-Provisionierung in der Region fehlschlägt → Fallback auf
> KV-basierte Quasi-Reservation mit grossem TTL und Warning-Log; manueller
> Reconcile danach."

## Backwards-Compat Implications

Was committen wir mit diesem Modul auf Dauer?

- Persistente Schemas: …
- Öffentliche API-Pfade: …
- Datenformate / Felder, die nie wieder verschwinden: …

Verweis auf `_backwards-compat.md` für die Regeln.

## Open Questions

Die offenen Fragen aus dem Build-Plan, hier inhaltlich präzisiert. Wenn dieses
Array nicht-leer ist, ist `status` höchstens `stub`.

- [ ] (TBD)

## Observability

- Welche Log-Felder sind Pflicht?
- Welche Metriken/Counts werden emittiert?
- Welche Alerts sind sinnvoll? (Schwellwert kann zur Laufzeit getunt werden)

## Test Strategy

- Unit: …
- Integration: …
- Concurrency / Load (falls relevant): …
- Cross-Tenant-Isolation-Test: ja/nein und wie

## Learnings (Runtime-Append)

Verweis: `learnings/<module-id>.log.md`

(Diese Sektion bleibt als Pointer; Inhalte landen append-only im Log.)

## Plan Revisions Originating Here

Verweis auf konkrete Plan-Revision-PRs, sobald entstanden.

(Initial leer; entsteht während Build.)
