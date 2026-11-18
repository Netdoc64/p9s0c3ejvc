# M24 — Learnings

### What happened
SemVer-Comparator (`src/services/version-cmp.ts`), `client_min_versions` Tabelle, `clientVersionGuard`-Middleware (Pflicht-Header X-Client-Version + X-Client-Platform, vergleicht gegen min_version, 426 wenn zu alt, Soft-Sunset-Headers).

### Decisions
1. **SemVer-Logik selbst implementiert** — pre-release < release der gleichen base, Pre-Release lex-vergleich. Tests decken Edge-Cases ab (1.4.2 < 1.4.10, 2.0.0-beta1 < 2.0.0).
2. **Middleware ist nicht automatisch aktiviert** — wird in M11 (Customer-bezogene Routes) explizit gemountet, da Tenant-API-Routes (B2B) das nicht brauchen.
3. **Sunset-Push-Notification (M23)** ist separater Job — nicht hier implementiert.
