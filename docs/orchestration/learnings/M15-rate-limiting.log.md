# M15 — Learnings

### What happened
KV-backed Token-Bucket Rate-Limit-Middleware (`src/middleware/rate-limit.ts`), 7 Klassen aus cross_cutting (`auth_login`, `magic_link_request`, ...), Headers `X-RateLimit-*` + `Retry-After`, Fail-Open bei KV-Outage. Auf `/v1/auth/magic-link/request`, `/v1/auth/oauth/authorize`, `/v1/auth/oauth/token` aktiviert.

### Decisions
1. **KV statt DO für Strict-Klassen in v1**: Spec verlangt DO für auth_login etc; KV ist eventual-consistent. Plan-Revision-Kandidat. Für Pilot mit niedrigem Volumen ist KV-Default ausreichend; minimaler Burst-Through-Window von <1s ist akzeptiert.
2. **Bucket-Identifier = `tenant/customer/ip`**: bei unauthenticated routes (magic-link/request) tenant=`_anon_t`, IP allein. Gut genug für Brute-Force-Defense.
3. **Tier-Multipliers** (free/starter/pro/enterprise) sind im Code definiert aber nicht aktiv (Tenant hat noch keinen `tier`-Feld). Plan-Revision wenn Pricing-Tiers eingeführt werden.
