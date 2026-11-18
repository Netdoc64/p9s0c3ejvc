---
module_id: M02b_customer_auth
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M02b — Customer Auth (OAuth 2.1 + PKCE + JWT)

## Goal

Endkunden-Authentifizierung für Mobile App, MCP-Agents und ggf. Web-Portal —
auf einer einzigen Mechanik (Authorization Code Flow + PKCE → JWT-Access-Token +
Refresh-Token), damit alle Konsum-Kanäle denselben Token-Verifier nutzen.

## Non-Goals

- **Kein Self-hosted Identity-Provider mit UI-Builder.** Wir hosten die OAuth-Endpoints
  selbst (im selben Worker, dünn), aber kein Branded-Login-UI-Konstruktionskasten.
- **Kein SSO / Enterprise-IdP** (Okta, Azure AD) in v1.
- **Keine MFA** in v1 (Magic-Link gilt als 2-Faktor-light dank Email-Beweis).
- **Keine Tenant-Operator-Logins** (Operator/Support nutzen weiterhin
  Tenant-API-Key + HMAC).

## Success Criteria

- Mobile-Client kann via Authorization Code Flow + PKCE einen JWT erhalten
- MCP-Client (Claude Desktop) nutzt **denselben** OAuth-Flow
- JWT-Access-Token TTL 15 min; Refresh-Token TTL 90 Tage, rotierbar (alter Refresh
  wird beim Erneuern invalidiert)
- Magic-Link-Login funktioniert (Email mit Einmal-Code, Passwort optional)
- Optional: Passwort-Login mit Argon2id-Hash
- Token-Validation in Hono-Middleware <2ms p99 (lokal verifiziert, kein DB-Hit
  pro Request — nur DB-Hit beim Refresh)
- Cross-Tenant: ein Customer-JWT von Tenant-A funktioniert NIE bei Tenant-B
- Concurrent Refresh: zwei Mobile-Devices mit demselben Refresh ⇒ Race-sicher
  (eines gewinnt, das andere muss neu loginen)

## Execution Intent (Vibe)

- **Spec strikt nach OAuth 2.1 (RFC 9700) + PKCE.** Nicht „OAuth-inspiriert" — der
  Standard ist nicht verhandelbar.
- **JWT minimal halten:** `iss` (= Tenant + Origin), `sub` (customer_id), `aud`
  (= "grosshandel.api"), `exp`, `iat`, `scope`, `tenant_id`. Keine Customer-PII drin.
- **HS256 mit per-Tenant-Secret** (nicht globales Secret) — erlaubt Schlüssel-Rotation
  pro Tenant ohne System-Downtime. Tenant-Secret steht in `tenants`-Tabelle aus M03.
- **Refresh-Tokens NIE in JWTs.** Opaque ULID, in D1 gespeichert mit Hash.
- **Magic-Link als Default**, Passwort als Opt-In pro Customer.
- **Keine Sessions** (kein Server-Side-Session-State). Stateless skaliert.

## Inputs Required

- M03 fertig (Tenant + Tenant-HMAC-Secret-Spalte erweitert um `customer_jwt_secret`)
- M04 fertig (Customer-Resource — wir erweitern um `login_identifier`,
  `authenticators`, `email_verified_at`)
- Email-Versand-Adapter (initial CF Email Workers oder via externes SMTP — siehe Open Questions)

## Deliverables

```
migrations/00XX_customer_auth.sql      auth_authenticators, auth_authorizations,
                                       auth_authorization_codes, auth_refresh_tokens,
                                       auth_magic_link_tokens
src/auth/
  oauth-server.ts                      /authorize, /token, /revoke
  jwt.ts                               sign + verify (HS256)
  pkce.ts                              code_verifier/challenge
  password.ts                          Argon2id (via @noble/hashes oder webcrypto)
  magic-link.ts                        Generieren + per Email versenden
src/middleware/
  customer-auth.ts                     liest Bearer-JWT, setzt c.var.customer_id
src/repos/auth.ts                      tenant-scoped
src/routes/auth.ts                     /v1/auth/login, /v1/auth/refresh,
                                       /v1/auth/magic-link/request,
                                       /v1/auth/magic-link/verify
tests/auth/...
```

## Happy Path (OAuth Code Flow)

1. **Mobile/MCP-Client** öffnet Browser auf
   `GET /v1/oauth/authorize?response_type=code&client_id=<app>&redirect_uri=<scheme>&code_challenge=<S256>&code_challenge_method=S256&scope=customer_self&state=<csrf>`
2. **Server** erkennt: kein gültiger JWT-Cookie → Login-Form (Magic-Link oder Passwort)
3. **Customer** loggt sich ein → Server erzeugt 5min-gültigen `authorization_code`,
   bindet ihn an `code_challenge`, redirected zu `<redirect_uri>?code=<c>&state=<state>`
4. **Client** prüft `state`, ruft `POST /v1/oauth/token` mit
   `grant_type=authorization_code&code=<c>&code_verifier=<v>&client_id=<app>`
5. **Server** verifiziert `code_verifier` gegen `code_challenge` (S256), tauscht
   Code gegen `{access_token: <JWT>, refresh_token: <opaque>, expires_in: 900}`
6. **Client** nutzt `Authorization: Bearer <JWT>` für API-Calls
7. **Bei Ablauf:** `POST /v1/oauth/token` mit `grant_type=refresh_token` →
   neuer JWT + neuer Refresh, alter Refresh wird invalidiert (Rotation)

## Happy Path (Magic-Link, Direkt-Login ohne OAuth-Flow)

Für simple Mobile-Login, kein Browser-Roundtrip:

1. `POST /v1/auth/magic-link/request {email}` → Server sendet Email mit 6-stelligem
   Code, gültig 10 min, max 1 Code aktiv pro Customer
2. `POST /v1/auth/magic-link/verify {email, code}` → JWT + Refresh-Token

(Dieser Pfad bleibt v1 für Mobile parallel zum OAuth-Flow.)

## Error Paths

| Symptom                                  | Code            | Recovery |
|------------------------------------------|-----------------|----------|
| Bearer-Token fehlt                       | `GH-AUTH-001`   | 401 |
| JWT signature invalid                    | `GH-AUTH-002`   | 401 |
| JWT expired                              | `GH-AUTH-005`   | 401 (Client refresht) |
| Scope nicht ausreichend                  | `GH-AUTH-004`   | 403 |
| Magic-Link-Code abgelaufen               | `GH-AUTH-006`   | 410 (neu anfordern) — **neuer Code**, siehe `_errors.md`-Update |
| Refresh-Token bereits verwendet (replay) | `GH-AUTH-007`   | 401, alle Refresh-Tokens des Customers invalidieren — **neuer Code** |
| PKCE-code_verifier mismatch              | `GH-AUTH-008`   | 400 — **neuer Code** |
| Cross-Tenant-Token-Versuch               | `GH-TENANT-001` | 404 |

> Code-Katalog wird im selben Build-Run um `GH-AUTH-006/007/008` erweitert.

## Fallbacks

- **Email-Versand down** → Magic-Link-Request gibt 503 mit Retry-After zurück;
  Customer kann per Passwort weiter (falls aktiviert)
- **D1 down** → Auth-Endpoints 503 (Refresh-/Login-fluss kann nicht ausgeführt
  werden); JWT-Validation für bereits ausgegebene Tokens läuft weiter (stateless)

## Backwards-Compat Implications

- JWT-Claims-Set permanent (additiv erweiterbar)
- Refresh-Token-Format: opaque ULID, niemals Klartext-Bedeutung
- OAuth-Endpoint-Pfade: `/v1/oauth/authorize`, `/v1/oauth/token`, `/v1/oauth/revoke` — permanent
- Authentifizierungs-Methoden additiv: Magic-Link erst, Passwort dazu, später
  Passkey (WebAuthn) — alles in `authenticators[]`-Subtabelle

## Open Questions

- [x] **OAuth 2.1 oder eigene Mechanik?** → **OAuth 2.1 + PKCE**.
  Standard, MCP-spezifiziert dahingehend, Mobile-Standard, kein Lock-in.
- [x] **Self-host vs. externer IdP (Auth0/Clerk/WorkOS)?** → **Self-host im selben Worker**.
  Reason: Kontrolle, keine monatlichen Kosten skaliert mit Customer-Anzahl,
  CF-Stack hat alle Primitives. Plan-Revision möglich falls Anforderungen
  (SSO/MFA/Compliance) das später kippen.
- [x] **Magic-Link oder Passwort als Default?** → **Magic-Link Default, Passwort opt-in**.
  Reason: Keine Passwort-Reset-Hölle, weniger Customer-Support, höhere Sicherheit
  bei B2B-Mobile-Use-Case.
- [x] **JWT-Algorithmus?** → **HS256 mit per-Tenant-Secret**.
  Reason: kein PKI-Overhead, Tenant-Isolation built-in, Schlüssel-Rotation pro
  Tenant ohne globalen Wartungsaufwand.
- [x] **Email-Versand-Provider?** → **`Resend` via API für v1**.
  Reason: einfache HTTP-API, gute Deliverability, freier Tier reicht für Pilot.
  Hinter Adapter-Interface, später swappable. CF Email Workers wäre nativer,
  aber UX/Deliverability noch unreif.
- [ ] **Customer-zu-Organisation-Mapping** (Florist mit mehreren Mitarbeitern, alle bestellen
      für gleichen Customer-Account)? — separate Auth-Subjekte mit
      `acts_for_customer_id` oder strikt 1 Login = 1 Customer?
  - Tendenz: später. v1 = 1 Login = 1 Customer. Plan-Revision bei
    Mehrbenutzer-Use-Case.

→ 5 von 6 OQs resolved → `status: specified`. Letzte ist Plan-Revision-Kandidat,
nicht Build-Blocker.

## Observability

- Login-Erfolgsrate, Login-Dauer p50/p99
- Token-Refresh-Rate (zu hoch = TTL möglicherweise zu kurz)
- `GH-AUTH-007` (Replay-Detection) — jede Anomalie alarmieren

## Test Strategy

- OAuth-Flow End-to-End-Test mit Mock-Browser (Auth-Server-Conformance Suite)
- PKCE-Korrektheit (Plain-vs-S256, Mismatch detection)
- Refresh-Rotation: alter Refresh nach Rotation 401
- Cross-Tenant-Test: Tenant-A-JWT auf Tenant-B-Resource → 404
- Magic-Link-Throttling: 1 Code pro Customer, weitere Requests werden idempotent

## Learnings

→ `learnings/M02b-customer-auth.log.md`

## Plan Revisions Originating Here

(initial leer)
