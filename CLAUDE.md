# Für Claude

Zuständigkeiten und Regeln stehen in [AGENTS.md](AGENTS.md). Kurz:

- Claude baut das **Backend**: alles außer `mobile/**`, `docs/frontend-*`,
  `scripts/check-frontend-plan.mjs` und `.github/workflows/mobile.yml`.
- Diese Frontend-Pfade gehören Codex. Braucht das Frontend etwas vom Backend,
  kommt es als Issue mit Label `claude`. Braucht das Backend etwas vom Frontend,
  ein Issue mit Label `codex` anlegen statt selbst in `mobile/` zu ändern.
- Branches heißen `orchester/…` oder `claude/…`, die CI prüft die Pfade daran.
