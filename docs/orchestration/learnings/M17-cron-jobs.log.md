# M17 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7 (build run #1)

### What happened
Cron-Framework: `CronLockDO` (Distributed-Lock via Durable Object), `runner.runJob` mit Audit in `cron_runs` + `cron_job_state`, Job-Registry, `scheduled()`-Handler dispatcht per Cron-Pattern, `heartbeat`-Job alle 15min als Smoke. Auto-Pause nach 3 consecutive failures.

### Decisions
1. **Lock-DO als eigenes Class `CronLockDO`** statt STOCK_DO mitzuverwenden. Saubere Trennung der DO-Konzepte; M08 darf STOCK_DO frei modellieren ohne Cron-Lock-Semantik.
2. **`pause_after_failures` als per-Job-Override** statt global. Heartbeat sollte z.B. nicht pausieren (weil dann ist auch das Pausen-Heartbeat weg). Domain-Jobs pausieren aggressiv (Default 3).
3. **`env.CRON_LOCK_DO` optional** in `Env`-Typ. Tests können Lock-DO weglassen indem sie `CRON_LOCK_DO: undefined` übergeben — das umgeht einen Edge-Case in `vitest-pool-workers` ("stacked storage" assertions schlagen fehl bei nested DO-Operationen während afterEach).
4. **`scheduled()` dispatcht über `controller.cron`** (CF-API gibt das Cron-Pattern). Job-Registry-Lookup via `getJobByCron`. Eindeutigkeit der Cron-Patterns ist Voraussetzung — bei Konflikt Plan-Revision (zwei Jobs gleicher Cron splitten).
5. **`cron_runs` ist append-only** — kein Update auf `started_at`, nur `ended_at`/`status`/`duration_ms`/`error_*`. Komplette Audit-Spur.

### Plan-Revision-Vorschlag (low priority)
- M17-Spec sagt „TTL-Cleanup-Job für Idempotency-Cache" — KV `expirationTtl` macht das automatisch. Job-Slot bleibt für Magic-Link-Codes (M02b) und Auth-Codes; im Skeleton bewusst weggelassen, bis M02b den Bedarf hat.

### Tests
- 7 Tests: success-Run, failure-Run, 3-failures→paused, idempotenter Doppel-Run, Registry-Bootstrap, Duplicate-ID-Throw, clear

### Confidence
high — Acceptance „Job-Idempotenz, Crash mit Lock-TTL, Failure-Audit" durch Tests abgedeckt.

### Edge-Case festgehalten
Workers-Types-Mismatch in `cloudflare:test` `ProvidedEnv` vs unserer `Env`-Definition (getSetCookie-property fehlt in einer Headers-Version). Workaround: `as unknown as Env`-Cast in Tests. Plan-Revision-Kandidat wenn neuere `@cloudflare/vitest-pool-workers`-Version das fixt.

### Follow-ups
- M12 registriert `outbox-sweep` (alle 1min)
- M16 registriert `secret-rotation-check` (täglich)
- M20 registriert `pricing-feed-pull` (täglich)
- M21 registriert `fefo-recheck` (täglich)
- M19 registriert `backup-d1-daily` (täglich)
- Jeder dieser Jobs erweitert `wrangler.toml [triggers].crons[]`.
