# Vibecoding Directives

Wie ein AI-Agent Module dieser App baut. Diese Datei wird **bei jedem Modul-Build
mitgegeben** — sie ist die Defaultwelt.

## Grundhaltung

> **Spec ist Kontrakt, Tests sind Wahrheit.**
> Der Build-Plan-Knoten und die Modul-Orchestration-Datei sind die Spec.
> Die `acceptance[]`-Tests entscheiden, ob du fertig bist. Wenn der Code
> Tests besteht, ist er fertig — auch wenn er nicht aussieht wie die Spec
> sich es vorgestellt hat. Wenn er Tests besteht **aber** die Spec verletzt,
> dokumentiere die Abweichung in `learnings/`.

## Zehn Direktiven

1. **Pure functions, dependency injection.** Engines (pricing, tax, gates)
   nehmen Daten als Argumente, nicht als globalen Fetch. Macht Tests trivial,
   macht Recombination möglich.

2. **Schmal anfangen, breit testen.** Lieber 3 Felder die korrekt durchlaufen
   als 30 die halb-implementiert sind. Felder kommen als Plan-Revision dazu.

3. **Keine Antizipation.** Wenn die Spec nichts über Mehrwährung sagt, baust
   du es nicht. Das ist explizit in `deferred[]` des Build-Plans — und falls
   nicht, wirf es als Open Question.

4. **Kein Refactor in Bug-Fixes.** Kein „während ich hier bin"-Aufräumen, das
   nicht Teil der Akzeptanz ist. Stattdessen: in `learnings/` als Vorschlag.

5. **Comments minimal.** Default ist *keine*. Eine Zeile nur, wenn das *Warum*
   nicht offensichtlich ist (versteckte Invariante, Workaround mit Issue-Link).
   Niemals erklären *was* der Code tut — Namen tun das.

6. **Errors aus dem Katalog.** Jeder geworfene Fehler hat einen Code aus
   `_errors.md`. Wenn der passende Code fehlt, **erst Katalog erweitern**, dann
   werfen. Niemals stringly-typed-Errors.

7. **Tenant-Awareness ist Default.** Jeder Datenzugriff geht durch einen
   Repository-Layer mit `tenant_id`-Pflichtparameter. Wenn dein Code direkt
   `db.select()` macht, ist es ein Bug, kein Feature.

8. **Money in Cents, Time in ISO-UTC, IDs prefixed.** Querschnitts-Standards
   (siehe `cross_cutting` im Build-Plan) sind nicht verhandelbar pro Modul.

9. **Tests vor Glanz.** Ein Modul mit grünen Akzeptanztests + hässlicher
   Implementation ist „shipped". Glanz kommt als Plan-Revision in eine
   spätere Phase.

10. **Abweichung loggen, nicht verschweigen.** Wenn du etwas anders gebaut hast
    als die Spec sagt — *immer* in `learnings/<modul>.log.md` mit `proposed_revision`.
    Stille Abweichungen sind Tech-Debt mit Verfallsdatum.

## Was Vibecoding **nicht** heisst

- Nicht: „Ich bau was sich richtig anfühlt." Akzeptanztests sind Wahrheit.
- Nicht: „Ich überspringe Tests weil Zeitdruck." Tests sind Teil der Definition
  von „shipped".
- Nicht: „Ich erfinde Felder im Order-Document." Schema-Änderungen sind
  Plan-Revisions mit Migration.
- Nicht: „Ich nutze ein anderes Framework, weil's mir lieber ist." Stack-
  Entscheidungen liegen im Build-Plan und werden über Plan-Revision geändert,
  nicht im Modul.

## Wenn Spec und Realität kollidieren

In dieser Reihenfolge:

1. **Open Question?** Schreib sie in die Modul-Datei (`open_questions[]`),
   markiere das Modul `blocked`, beende den Build dieses Moduls.
2. **Spec-Lücke aber lösbar?** Mach den minimalen Fix, dokumentiere als
   `proposed_revision` im Learning-Log.
3. **Spec-Konflikt mit Querschnittsstandard?** Querschnitt gewinnt, Modul-Spec
   wird per Plan-Revision korrigiert.
4. **Externer Service tut was anderes als gedacht?** Adapter dazwischen, Adapter
   wird mit Spec verhandelt — niemals leakt das ins Domain-Modell.

## Reviewer-Checkliste (für menschliche Review nach Auto-Build)

- [ ] Alle `acceptance[]` durch Tests abgedeckt (nicht nur erwähnt)
- [ ] Kein neuer Fehler ohne Eintrag in `_errors.md`
- [ ] Keine Felder im Order-Document erfunden (oder als Revision dokumentiert)
- [ ] Tenant-Filter in jedem Repo-Pfad
- [ ] Money als Integer, Time als ISO-UTC
- [ ] `learnings/<modul>.log.md` existiert (auch wenn nur „nichts auffälliges")
