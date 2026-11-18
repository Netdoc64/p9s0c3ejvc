# Runtime Self-Optimization Protocol

Wie der Plan sich während des Builds **selbst verbessert**, ohne in Chaos zu fallen.

## Grundannahme

Der Build-Plan ist eine Hypothese. Realität wird Lücken aufdecken: API anders als
gedacht, Performance-Trade-offs sichtbar, Akzeptanzkriterium zu eng oder zu weit.
Diese Erkenntnisse müssen **in den Plan zurückfliessen**, sonst veraltet er bei
jedem Modul, das gebaut wird.

Gleichzeitig: nicht jeder Augen-Blink ist Anlass für Plan-Revision. Wir wollen
**zwei Kanäle**:

1. **Learning-Log** (formlos, unkritisch, append-only)
2. **Plan-Revision** (formal, reviewbar, mit Backwards-Compat-Statement)

## Kanal 1 — Learning-Log

**Zweck:** Beobachtungen während des Builds festhalten, ohne dass sofort der Plan
mutiert wird. Quelle für spätere Revisions.

**Wo:** `docs/orchestration/learnings/<MODUL_ID>.log.md` — eine Datei pro Modul.

**Wer schreibt:** der Coding-Agent während/nach dem Modul-Build, oder ein
menschlicher Reviewer.

**Format:** append-only, jeder Eintrag ein Block:

```markdown
## 2026-04-28 14:32 — by claude-opus-4-7 (build run #3)

### What happened
Beim Implementieren der Pricing Engine ist mir aufgefallen, dass `qty_breaks`
in der Spec keine Aussage zur Stückelung über mehrere Order-Lines macht.

### Decision taken
Pro Line ausgewertet (nicht kumulativ). Tests entsprechend.

### Confidence
medium — die Spec sagt es nicht, ich habe die wahrscheinlichste Interpretation
gewählt.

### Proposed revision
- target: `build-plan.json#modules.M06_pricing.open_questions`
- action: resolve question „Mengenstaffel kumulativ oder pro Position?" → pro Position
- rationale: Branchenüblich (Blumenhandel), kumulativ wäre invasiv im Datenmodell.
```

**Regeln:**

- Niemals Einträge editieren oder löschen — nur anhängen.
- Jeder Eintrag hat: Datum, Autor (Mensch oder Modell-ID), Build-Run-Nummer.
- `Confidence` ehrlich: `low` (vermutet), `medium` (plausibel), `high` (durch Test belegt).
- `Proposed revision` nur wenn der Eintrag eine Plan-Änderung nahelegt.

## Kanal 2 — Plan-Revision

**Zweck:** den Plan tatsächlich mutieren, mit Review-Pflicht.

**Wer triggert:** menschlicher Reviewer (oder Autopilot mit `auto_revise=true`-Flag,
zukünftig).

**Wann:**

- Phase-Exit-Review: vor Übergang in nächste Phase werden alle Learning-Logs
  durchsucht nach `proposed revision`.
- Ad-hoc: wenn ein In-Flight-Modul auf einen Showstopper trifft.

**Wie:**

1. Auf neuem Branch (`plan-revision/<short-id>`) Änderungen am Build-Plan und/oder
   Modul-Files vornehmen.
2. PR-Beschreibung **muss** enthalten:
   - Welche Learnings die Revision motivieren (Links auf Log-Einträge)
   - **Backwards-Compat-Statement** (siehe `_backwards-compat.md`):
     - betroffene Module bereits geshipped? → Migration nötig
     - Schema-Versionsbump? → Old-→-New-Reader gepflegt
     - API-Pfad-Änderung? → niemals — neuer Pfad, alter `deprecated`
   - Welche Akzeptanztests betroffen sind
3. Merge erst, wenn ein menschlicher Reviewer (oder konfigurierter Auto-Approver)
   das OK gibt.

**Versionsbump des Plans:** `build-plan/1.0` → `build-plan/1.1` für additive
Revisions, `2.0` für breaking. Breaking ist sehr selten erlaubt (siehe
`_backwards-compat.md`).

## Was den Plan **NICHT** mutieren darf

- Stillschweigende Änderungen direkt im Code-Review (ohne PR an Plan)
- Modul-Code, das von der Spec abweicht **ohne** Learning-Log-Eintrag
- ID-Umbenennungen (`M06_pricing` bleibt für immer `M06_pricing`)
- Reihenfolge in `phases[*].modules[]` ohne Begründung
- Rückwirkende Akzeptanzänderung an `shipped`-Modulen (statt: neues Modul
  `M06b_pricing_v2` mit Migration)

## Self-Optimization der Orchestration-Schicht selbst

Diese Datei (`_self-optimization.md`) ist auch revidierbar. Wenn ein Build-Run
zeigt dass das Protokoll selbst Lücken hat (z.B. Konflikt-Resolution zwischen
zwei gleichzeitigen Learnings), wird **diese Datei** per Plan-Revision angepasst.
Dann sind alle nachfolgenden Runs auf neuer Version. Die Schicht hat denselben
Backwards-Compat-Anspruch wie der Plan selbst.

## Telemetrie für den Plan

Nach jeder gelaufenen Phase werden aggregierte Metriken in
`docs/orchestration/learnings/_phase-summary.md` gepflegt:

```markdown
## P1_foundation — Run #2 (2026-05-12)

- Modules planned:        3 (M01, M02, M03)
- Modules shipped:        3
- Modules blocked:        0
- Open Questions resolved: 0 (P1 hatte keine offenen)
- Learning-Log entries:   7
- Plan-Revisions issued:  1 (PR #4 — `idempotency.ts` interface refinement)
- Acceptance tests added: 12
- Average build duration: 18min/Modul (Agent + Review)
```

Damit sehen wir **wo der Plan gut war** (wenig Learnings, keine Blocker) und **wo
er Geschmacksache war** (viele Logs in einem Modul = Spec war schwammig).

## Prinzip

> Der Plan ist nicht statisch. Er ist auch nicht chaotisch.
> Er ist **append-only mit Versionierung** — wie ein Git-Repo seines eigenen Konzepts.
