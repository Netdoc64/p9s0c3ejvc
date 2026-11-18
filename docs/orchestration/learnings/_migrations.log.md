## Migrations-Waechter (tests/db/migrations-numbering.spec.ts)
- Anlass: am 18.11. wollten drei PRs gleichzeitig Migration 0022.
- Regel: Name `^\d{4}_[a-z0-9_]+\.sql$`, jedes Praefix genau einmal, lueckenlos ab 0001. Naechste freie Nummer = max+1 auf aktuellem origin/main.
- Technik: Dateiliste per `import.meta.glob("/migrations/*", ?raw)` (Workers-Pool hat kein fs); `*` statt `*.sql`, damit falsch benannte Dateien auffallen.
