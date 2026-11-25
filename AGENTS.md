# Zuständigkeiten: Codex und Claude

In diesem Repo arbeiten zwei Agenten parallel. Damit sie sich nicht in die Quere
kommen, ist das Repo nach **Schicht** geteilt. Die CI prüft das bei jeder PR
(`scripts/check-zustaendigkeit.mjs`, Schritt „Zuständigkeit“ in `build-and-test`).

| Seite | Wer | Branches | Pfade |
|---|---|---|---|
| **Frontend** | Codex (Konto `fsvarrunner`) | `codex/…`. Jede PR des Codex-Kontos zählt als Frontend, egal wie der Branch heißt | `mobile/**`, `admin/**`, `docs/frontend-*`, `scripts/check-frontend-plan.mjs`, `.github/workflows/mobile.yml` |
| **Backend** | Claude (Orchester und Sitzungen) | `orchester/…`, `claude/…` | alles andere: `src/**`, `migrations/**`, `tests/**`, `scripts/**`, `wrangler.toml`, `docs/**` außer `docs/frontend-*`, `.github/workflows/**` außer `mobile.yml` |

Die Liste der Frontend-Pfade steht einmal in `scripts/zustaendigkeit.mjs`. Ändert
sie sich, dann dort und in dieser Tabelle.

## Der Vertrag zwischen beiden

Die Kunden-API unter `/v1/customer` und ihre Beschreibung in `src/openapi/spec.ts`
gehören zum **Backend**. Braucht die App etwas Neues oder anderes (Feld, Endpunkt,
Fehlercode), legt Codex ein Issue mit dem Label `claude` an:

- was die App braucht und warum (Ansicht, Ablauf),
- wie die Antwort aussehen soll (Beispiel-JSON),
- welche Fehlerfälle die App unterscheiden muss.

Bis das Backend steht, arbeitet die App gegen Mock-Daten (`mobile/src/demo.ts`).

## Aufgaben finden

- Issues mit Label `codex`: Frontend, für Codex.
- Issues mit Label `claude`: Backend, für Claude.
- Pilotentscheidungen Q01–Q06 (`docs/frontend-plan.md`) trifft der Betreiber, kein Agent.

## Regeln für beide (das Repo ist öffentlich)

- Commits nur mit der GitHub-noreply-Adresse (`<id>+<login>@users.noreply.github.com`).
  Die CI prüft Autor, Committer und `Co-authored-by`.
- Keine Firmennamen, keine echten E-Mail-Adressen (nur `.example` / `example.com`),
  keine Konto-IDs, keine workers.dev-Adressen, keine Namen privater Repos.
- Eine PR je Issue, „Closes #<nr>“ in die Beschreibung. **Eine fertige PR nicht als Entwurf
  öffnen**, oder sie gleich danach aus dem Entwurf nehmen: Das Gate mergt keinen Entwurf, und
  niemand sonst nimmt ihn heraus. Entwurf nur, solange wirklich noch gearbeitet wird.
- Gemergt wird automatisch über das Gate, sobald `build-and-test` grün ist.
- Neue Migrationen bekommen die nächste freie Nummer. Der Migrations-Wächter
  (`tests/db/migrations-numbering.spec.ts`) verlangt eindeutige, lückenlose Präfixe.
- Typecheck und Tests grün: `npx -y pnpm@10.33.2 typecheck` und `test` im Hauptordner,
  `npm run typecheck` in `mobile/`.
