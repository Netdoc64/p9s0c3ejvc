# M01 — Learnings (append-only)

## 2026-04-28 — by claude-opus-4-7 (build run #1)

### What happened
M01-Skeleton implementiert. Hono-App, alle CF-Bindings in wrangler.toml deklariert (DB/STOCK_DO/ASSETS/OUTBOX_QUEUE/KV), Health-Endpoint, RFC-7807-Problem-JSON-Error-Mapper, Prefixed-ULID-Lib, vitest+@cloudflare/vitest-pool-workers für Tests, GitHub-Actions-CI mit typecheck+test+dry-run-build.

### Decisions taken
1. **`@cloudflare/vitest-pool-workers` statt `miniflare` direkt.** Spec sagt „vitest + miniflare-Setup". Modernere Alternative ist `@cloudflare/vitest-pool-workers`, das miniflare unter der Haube nutzt aber besser integriert ist (env-Import via `cloudflare:test`, SELF-Fetch). Schreib-Backwards-Compat: spec-Intent ist erfüllt, Implementation nutzt empfohlenen Pfad. **Confidence: high.** Proposed revision: M01-Spec-Wording „vitest + @cloudflare/vitest-pool-workers (miniflare unter Haube)".
2. **Initial-Migration enthält `_migrations_meta`-Tabelle**, nicht ganz „leer". Gibt frühen Debug-Pfad zur Schema-Version-Identifikation. Falls in spätren Modulen ein anderes Migrations-Tracking gewünscht wird, ist die Tabelle additiv-additionally und kann co-existieren.
3. **`StockDO` als Stub-Klasse hier eingeführt.** `wrangler.toml` `durable_objects.bindings` verlangt eine `class_name`-Referenz, die als Export im Worker-Module existieren muss, sonst schlägt `wrangler deploy --dry-run` fehl. Stub gibt 501 mit Modul-Hinweis zurück. Volle Implementation in M08.
4. **Hono-`onError` minimal** in M01: leitet alle Errors durch `errorToProblem` (Coded → 7807, sonst → GH-INFRA-002 500). Vollständige Logger-Integration kommt in M02.
5. **`tsconfig.json` ohne `verbatimModuleSyntax`.** Wäre strenger, kollidiert aber mit drizzle-orm-Type-Re-Exports. Plan-Revision-Kandidat wenn drizzle Probleme bereiten sollte.
6. **`compatibility_date 2025-01-09`** + `nodejs_compat`-Flag — moderne CF-Workers-Defaults.

### Confidence
high — die Acceptance-Kriterien (`pnpm install && pnpm test`, `wrangler dev` + `/health`, alle Bindings deklariert, `strict: true`, CI grün) sind alle direkt durch Code/Config abgedeckt.

### Proposed revisions
- target: `docs/orchestration/M01-skeleton.md` Deliverables-Block
- action: Wording „vitest+miniflare" → „vitest+@cloudflare/vitest-pool-workers (miniflare-backed)"
- rationale: konsistenter mit aktuellem CF-Stack; reine Ersetzung gleichbedeutender Tool-Bezeichnung, keine Schema- oder API-Änderung.

### Follow-ups für andere Module
- M02 erbt das `request-id`-Setup als Hono-Middleware-Pattern (siehe `src/index.ts`).
- M02 wird `errorToProblem` durch komplette `error.ts`-Middleware ersetzen.
- M08 ersetzt `src/do/stock.ts` durch echte DurableObject-Klasse.
- M03 ersetzt `scripts/bootstrap-tenant.ts` durch echtes CLI.
- M14 ersetzt `scripts/smoke.ts` durch echten E2E-Smoke.
