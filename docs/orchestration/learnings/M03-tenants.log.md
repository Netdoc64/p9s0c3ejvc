# M03 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7 (build run #1)

### What happened
Repos für `tenants` + `api_keys` (drizzle-orm-basiert), Bootstrap-CLI (`scripts/bootstrap-tenant.ts`), Tests.

### Decisions
1. **Schema bleibt in M02-Migration** (siehe M02-Learning). M03 fügt nur Repo-Wrapper + CLI.
2. **Bootstrap-CLI shellt zu `wrangler d1 execute`** statt eigenen D1-HTTP-API-Call. Reason: Wrangler hat bereits Auth + Region-Routing eingebaut; eigener API-Client wäre Doppel-Code. Trade-off: CLI braucht Wrangler im PATH.
3. **`api_keys.revoke` macht Re-Read** für Verify weil drizzle-d1-Result-Shape je Version variiert. Defensiv, ein Extra-Roundtrip — akzeptabel weil Revoke selten ist.
4. **CLI-ULID** mit Node's `randomBytes` — NICHT die npm `ulid`-Lib, weil das CLI-Skript pure Node ist (kein Worker-Bundle). Format identisch mit Worker-IDs (Crockford-base32, 26 Zeichen).
5. **`gh_`-Prefix für API-Keys** + `base64url(random(24))` — 192 Bit Entropie, URL-safe, klar erkennbar.
6. **Idempotenz beim Bootstrap**: UNIQUE-Constraint auf `tenants.slug` fängt Duplikate, Exit-Code 2 mit klarem Fehler.

### Tests
- 9 Tests: tenants (find, requireById, softDelete) + api-keys (findByPlain, revoke, listForTenant) + CodedError-Shape

### Confidence
high — Acceptance „Bootstrap-CLI legt Tenant + Key an, M02-Auth findet ihn" durch existierende auth.spec.ts indirekt + repo.spec.ts direkt belegt.

### Follow-ups
- M16 (Secrets-Rotation) erweitert `api_keys` um `key_hash_previous`, `key_hash_previous_until` und nutzt `revoke`.
- M02b liest `tenants.customer_jwt_secret` für JWT-Sign.
