# M14 — Learnings

### What happened
`scripts/seed-pilot.ts` (idempotent, fixed-IDs, 26 SKUs, 3 Customers, Default-Price-List + Qty-Breaks + Customer-Specials, Initial-Stock-Adjust). `scripts/smoke.ts` macht echten E2E-Order-Flow gegen laufenden Worker.

### Decisions
1. **Fixed ULIDs deterministisch hard-coded** (`t_pilot`, `cust_floraly_de` …) statt Faker mit Seed. Reason: Snapshot-Tests brauchen 100% reproduzierbare IDs; Faker mit fixed Seed ist *fast* deterministisch, aber Library-Updates können Output ändern.
2. **`INSERT OR IGNORE`** überall — Re-Run zerstört nichts.
3. **Smoke setzt Env-Vars für API-Key/HMAC-Secret** (aus seed-Output kopieren) — keine geheimen Daten im Repo.
4. **CI-Variante (Vitest)**: Plan-Revision-Kandidat. Aktuell läuft smoke nur lokal/staging gegen echten Worker.

## 2026-11-17 — Seed gegen Staging

- Der Seed schreibt Bestand nur als Audit-Zeilen in `stock_movements`; echten Bestand (Charge + DO-Zähler) legt allein `POST /v1/stock/batches` an. Der Smoke macht deshalb vor der Bestellung einen Wareneingang (sonst `GH-FEFO-001`) und nutzt je Lauf eindeutige Idempotency-Keys.
- Tenant bekommt fiktive USt-IdNr. + Anschrift (Rechnungspflicht, siehe M22), jeder Testkunde eine eigene Anschrift im eigenen Land.
- **Nicht** erneut gegen eine bestehende DB laufen lassen, um Zugangsdaten zu bekommen: der Key-Insert ist `INSERT OR IGNORE`, der ausgegebene neue Key wird nie gespeichert.
