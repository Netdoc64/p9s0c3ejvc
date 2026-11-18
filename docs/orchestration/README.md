# Orchestration Layer

Eine Schicht **unter** dem [build-plan](../build-plan.md). Der Build-Plan ist die
Map. Hier stehen die Wegbeschreibungen pro Zweig.

## Wozu

Der Build-Plan benennt Module, Phasen, Stack-Entscheidungen. Aber:

- *Wie* soll ein Coding-Agent ein Modul angehen?
- *Was* genau heisst „done"?
- *Wenn etwas schiefgeht* — welcher Fehler, welcher Recovery-Pfad?
- *Was lernt der Agent während des Builds* und wie fliesst das zurück?

Diese Schicht beantwortet das. Jede dieser Fragen hat eine Datei.

## Aufbau

```
docs/orchestration/
├── README.md                 (diese Datei)
├── _vibecoding.md            wie AI-Agents hier arbeiten sollen
├── _errors.md                zentraler Error-Katalog (jeder Fehler wird hier registriert)
├── _self-optimization.md     wie der Plan sich zur Laufzeit selbst verbessert
├── _backwards-compat.md      Versionierungs- und Kompatibilitätsregeln
├── _template.md              Vorlage für Modul-Orchestration-Dateien
├── M01-skeleton.md           Modul-Zweig (vollständig)
├── M02-middleware.md         Modul-Zweig
├── ...                       je ein File pro Modul aus build-plan.json
└── learnings/                Runtime-Append-Only-Notizen pro Modul
    ├── .gitkeep
    └── M01-skeleton.log.md   (entsteht beim Build)
```

Dateien mit `_`-Präfix sind Querschnittsregeln. Modul-Dateien folgen
[`_template.md`](./_template.md).

## Wie der Build-Plan auf diese Schicht zeigt

Jeder Modul-Eintrag im Build-Plan trägt ein Feld `path`:

```json
{
  "id": "M01_skeleton",
  "path": "docs/orchestration/M01-skeleton.md",
  ...
}
```

Beim Autopilot-Lauf liest der Agent für jedes Modul:

1. den Build-Plan-Knoten (Stack, Deps, Acceptance)
2. die Modul-Orchestration-Datei (Goal, Vibe, Error-Paths)
3. `_vibecoding.md` + `_errors.md` + `_backwards-compat.md` (immer)

…und schreibt nach Abschluss in `learnings/<modul>.log.md`.

## Lebenszyklus eines Modul-Files

```
1. STUB             — angelegt mit Template, viele TBD-Felder
2. SPECIFIED        — Open Questions geklärt, Akzeptanz festgezurrt → bereit für Build
3. IN-FLIGHT        — Agent arbeitet daran, Learnings landen im Log
4. SHIPPED          — Akzeptanz erfüllt, Tests grün, Phase-Exit-Check passed
5. EVOLVED          — spätere Plan-Revision hat Inhalte verändert (mit Migration)
```

Status steht im Front-Matter jedes Modul-Files (`status: stub | specified | in-flight | shipped | evolved`).

## Goldene Regeln

1. **Keine Doppelung mit dem Build-Plan.** Wenn etwas im Build-Plan steht
   (z.B. `depends_on`, `acceptance`), wird hier nicht wiederholt — nur
   referenziert. Eine Wahrheit pro Fakt.

2. **Jeder Fehler steht in `_errors.md`.** Modul-Files referenzieren Codes
   (`GH-AUTH-001`), erfinden keine eigenen Texte.

3. **Vibe ist explizit.** Jedes Modul-File hat einen `Execution Intent`-Block,
   der dem Agent Spielraum statt Mikromanagement gibt — siehe `_vibecoding.md`.

4. **Lernen ist append-only.** Nichts in `learnings/` wird je überschrieben.
   Plan-Revisionen entstehen aus Lernen, nicht durch Inplace-Edits.

5. **Backwards-compat ist Pflicht.** Schema-Versionen, Modul-IDs, API-Pfade
   bleiben stabil — siehe `_backwards-compat.md`.
