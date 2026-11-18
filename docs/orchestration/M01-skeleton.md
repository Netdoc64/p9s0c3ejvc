---
module_id: M01_skeleton
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P1_foundation
---

# M01 — Repo Skeleton + CI

## Goal

Ein baufähiges Hono-Worker-Projekt mit allen Cloudflare-Bindings, lokaler
Dev-Loop, einem grünen Smoke-Test und einer durchlaufenden CI. Ab hier kann
jedes andere Modul anfangen.

## Non-Goals

- Keine Domänen-Logik (kein Customer, Order, Stock — kommt in M02+)
- Kein Auth über `/health` hinaus
- Kein Deploy-Automation in Production (Staging reicht für jetzt)

## Success Criteria

- `pnpm install && pnpm test` grün auf einem frischen Clone
- `wrangler dev` startet lokal, `GET /health` → `{status:"ok", version, commit}`
- Alle Bindings (`DB`, `STOCK_DO`, `ASSETS`, `OUTBOX_QUEUE`, `KV`) in
  `wrangler.toml` deklariert und in `Env`-Type abrufbar
- GitHub-Actions-Workflow `ci.yml` läuft auf jedem PR durch (typecheck + test +
  build)
- Drizzle-Migration für eine leere Initial-DB funktioniert (`pnpm db:migrate`)
- TypeScript `strict: true`, keine `any` im Skeleton

## Execution Intent (Vibe)

- Mini-aber-vollständig: lieber ein 50-Zeilen-Skeleton der alles korrekt verdrahtet
  als ein 500-Zeilen-Skeleton der vorgreift.
- Konventionen festklopfen, die nachfolgende Module ungefragt erben (Pfad-Layout,
  Test-Setup, Error-Wrapper-Stub).
- Bindings als TypeScript-Type generieren via `wrangler types` — nicht handgepflegt.
- Single-Worker erstmal (siehe Open Question Monorepo). Wenn Monorepo gewählt,
  wird dieses Modul vorm Build neu spezifiziert.

## Inputs Required

- Build-Plan-Knoten: `M01_skeleton`
- Cross-Cutting: alle (siehe `build-plan.json#cross_cutting`)
- Stack-Decisions: `runtime`, `framework`, `orm`, `validation`, `package_manager`
- Cloudflare-Account mit Workers-Plan + D1 + DO + R2 + Queues aktiviert
- Antwort auf `global_open_questions[0]` (Monorepo ja/nein) — **blockierend**
- Antwort auf `global_open_questions[1]` (Primary-Region für D1)

## Deliverables (Outputs)

```
grosshandel/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json                    strict, moduleResolution: bundler
├── wrangler.toml                    Bindings, vars
├── drizzle.config.ts
├── vitest.config.ts                 mit miniflare-Setup
├── .github/workflows/ci.yml
├── migrations/
│   └── 0001_init.sql                leer ausser metadata-Tabelle
├── scripts/
│   ├── bootstrap-tenant.ts          (Stub — befüllt M03)
│   └── smoke.ts
├── src/
│   ├── index.ts                     Hono-App, Routes-Registry
│   ├── env.ts                       Env-Type für Bindings
│   ├── routes/
│   │   └── health.ts                GET /health
│   ├── middleware/                  (leer ausser Stubs für M02)
│   ├── errors/
│   │   ├── catalog.ts               import aus _errors.md (initial leer)
│   │   └── problem-json.ts          RFC-7807-Mapper
│   └── lib/
│       └── ids.ts                   Prefixed-ULID-Generator
└── tests/
    └── health.spec.ts               Smoke-Test
```

## Happy Path

1. `pnpm init`, deps: `hono`, `@hono/zod-openapi`, `zod`, `drizzle-orm`, `drizzle-kit`,
   `vitest`, `@cloudflare/workers-types`, `miniflare`, `wrangler`
2. `tsconfig.json` mit `strict: true`, `target: ES2022`, `lib: ["ES2022"]`,
   `types: ["@cloudflare/workers-types"]`
3. `wrangler.toml` mit Bindings (Platzhalter-IDs für D1/KV/R2/DO/Queue)
4. `src/env.ts` definiert `Env`-Type
5. `src/index.ts` erzeugt Hono-App, registriert `routes/health`
6. `src/routes/health.ts` returniert `{status, version: env.WORKER_VERSION,
   commit: env.GIT_COMMIT}`
7. Drizzle-Config + leere Initial-Migration
8. Vitest-Setup mit miniflare-D1-In-Memory
9. Smoke-Test: `GET /health` → 200, JSON enthält erwartete Felder
10. CI-Workflow: typecheck + test + `wrangler deploy --dry-run`
11. Push auf Branch, PR öffnen, CI grün ⇒ shipped.

## Error Paths

| Symptom                                          | Code             | Recovery                   |
|--------------------------------------------------|------------------|----------------------------|
| `GET /health` 5xx wegen fehlender Env-Variable   | `GH-INFRA-002`   | Fail-fast beim Start, klare Log-Message |
| Wrangler-Bindings fehlen lokal                   | `GH-INFRA-001`   | `wrangler dev` zeigt Liste nicht-konfigurierter Bindings |
| Drizzle-Migration scheitert (z.B. SQL-Syntax)    | `GH-INFRA-002`   | CI bricht; Migration muss vor Merge fix sein |

## Fallbacks

- Falls Cloudflare Queues im Account-Plan nicht verfügbar: Binding auskommentieren,
  Modul `M12_outbox_webhooks` markiert als blockiert in eigener Open-Question.
  Skeleton bleibt baufähig.
- Falls DO im Account nicht aktiviert: Binding auskommentieren, M08 blockiert.
  Skeleton bleibt baufähig.

## Backwards-Compat Implications

- **Pfad-Layout `src/routes/`, `src/middleware/`, `src/repos/` etc.** wird dauerhaft
  Konvention der Codebase. Spätere Umstrukturierung = Plan-Major-Bump.
- **`Env`-Type-Shape** ist API zwischen Worker und Bindings — additiv erweiterbar,
  niemals Umbenennung.
- **Health-Endpoint-Format** stabil (Tooling/Monitoring könnte daran hängen).
- **Migration-Numbering** beginnt bei `0001` und ist forward-only.

## Open Questions

- [x] ~~**Monorepo oder Single-Worker?**~~ → **Resolved (G1, 2026-04-28): Single-Worker**.
  Alles unter `src/`, MCP als Sub-Route im selben Hono-App.
- [x] ~~**Primary-Region für D1?**~~ → **Resolved (G2, 2026-04-28): `weur`**.
  Festgelegt in `wrangler.toml`.

→ Modul ist `unblocked`, bereit für Build.

## Observability

- Strukturiertes Log auf `console.log(JSON.stringify(...))`-Basis (Workers-Logs)
- Pflichtfelder: `request_id`, `route`, `status`, `duration_ms`
- Health-Endpoint emittiert kein Log (Spam-Schutz; Monitoring-Probe wird gehäuft)

## Test Strategy

- **Unit:** `lib/ids.ts` (Prefix-Korrektheit, Sortierbarkeit, Kollisionsdichte
  über 100k Generierungen)
- **Integration:** `health.spec.ts` über miniflare
- **CI:** `pnpm typecheck && pnpm test && pnpm build`

## Learnings (Runtime-Append)

→ `learnings/M01-skeleton.log.md` (entsteht beim Build)

## Plan Revisions Originating Here

(initial leer)
