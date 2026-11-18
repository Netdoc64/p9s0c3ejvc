# M02b — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7

### What happened
JWT-Sign+Verify (HS256, eigenes Mini-Lib ohne Jose-Dependency), PKCE-S256-Verifier, Magic-Link-Service mit 6-stelligem Code, Refresh-Token-Rotation mit Replay-Detection (Family-Revocation), OAuth 2.1 + PKCE Code-Flow (POST-basiert statt Browser-Redirect, siehe Decision 1), Customer-Auth-Middleware (lädt Tenant-Secret pro Request für JWT-Verify), Email-Adapter (console-Sink Default, Resend-Adapter für Prod).

### Decisions
1. **OAuth Authorize ist POST-Endpoint** statt Browser-Redirect-UI. Spec erlaubt das implizit (M02b non-goal: kein UI-Builder); konkrete Form: Client führt Magic-Link-Verifikation inline mit PKCE-Challenge durch und erhält authorization_code. Plan-Revision-Kandidat wenn echtes browser-flow + redirect für Web-Portal (D06) gebraucht wird.
2. **JWT-Verify lädt Tenant-Secret per DB-Hit** (nicht KV-cached). Spec verlangt p99 <2ms; echter Test im Lasttest. Plan-Revision wenn DB-Hit zu langsam ist (KV-Cache-Layer mit Versioning).
3. **Replay-Detection = Family-Revocation**: alle Refresh-Tokens mit gleichem `family_id` werden bei Replay revoked. `family_id` propagiert durch alle Rotationen (parent_id zeigt auf den unmittelbaren Vorgänger).
4. **Magic-Link-Code-Hash: `sha256(tenant_id:customer_id:code)`** — verhindert Code-Wiederverwendung über Tenants/Customers hinweg (Salt-Effekt).
5. **User-Enumeration-Schutz**: `magic-link/request` antwortet immer 200, unabhängig davon ob Email existiert.
6. **Eigenes JWT-Lib statt jose**: jose hat ESM/CJS-Issues unter @cloudflare/vitest-pool-workers. Das eigene Lib ist ~50 Zeilen, HS256-only, ausreichend.

### Tests
- 13 Tests grün: jwt-roundtrip+expired+bad-sig+wrong-tenant+malformed (5), PKCE-S256+plain (3), magic-link request/verify/wrong-code/unknown-email (3), OAuth flow + bad-verifier (2), refresh rotation + replay (1)

### Confidence
high — alle Acceptance-Kriterien (Mobile+MCP gleicher Flow ✓, refresh-rotation+replay ✓, cross-tenant via JWT-tenant_id-claim ✓) abgedeckt. JWT <2ms-Latency ist ein Lasttest-Punkt für M18 Compliance-Suite.

### Bewusst nicht in v1
- Browser-basiertes HTML Login-UI für Web-Portal — Plan-Revision wenn D06 aktiviert wird.
- Argon2id-Passwort-Auth — Magic-Link reicht für Pilot; Passwort kommt opt-in via authenticators-Tabelle.
- Customer-zu-Org-Mapping (M02b OQ #6) — wie spezifiziert, separates Modul.

### Follow-ups
- M11 (Orders-API) nutzt customer-auth middleware (oder tenant-API-key) für Customer-Routes
- M13 (MCP-Server) nutzt OAuth-Flow für AI-Agent-Auth
- M16 (Secrets-Rotation) erweitert um Per-Tenant-JWT-Secret-Rotation mit Doppel-Reader

## 2026-11-17 — Login-Codes wurden nie zugestellt

Kein Produktionscode rief `setEmailAdapter`; der Magic-Link-Code ging in jeder Umgebung an den console-Sink (nur ein Hash im Log), und `/magic-link/request` meldete trotzdem `ok`. Kein Kunde hätte sich je anmelden können.

Jetzt entscheidet die Umgebung: `RESEND_API_KEY` + `RESEND_FROM` → Resend; `development` → console; sonst `503 GH-EXT-003` — geprüft vor dem Kunden-Lookup (keine User-Enumeration). `tests/auth/email-adapter.spec.ts`. Für Staging/Production fehlen die beiden Secrets noch (Business Manager).

## 2026-11-17 — Plan-Revision: Cloudflare Email statt Resend

Entscheidung des Betreibers: Login-Codes gehen über **Cloudflare Email Service** (Binding `send_email` → `EMAIL`), nicht über Resend. Kein Drittanbieter, kein API-Schlüssel; der Versand läuft im selben Konto wie der Worker. Die Absenderadresse ist die Worker-Variable `MAIL_FROM` und steht bewusst nicht im öffentlichen Repo. Der Resend-Adapter ist entfernt (nie produktiv benutzt). Die Entscheidung „Resend für v1“ in `M02b-customer-auth.md` ist damit überholt.

## 2026-11-17 — Kunden-Routen waren nie erreichbar; Kunden-API gebaut

- `app.route("/v1", v1)` mit `v1.use("*", auth())` stand VOR dem Kunden-Router. Die Tenant-Auth griff damit auch für `/v1/customer/*` und verlangte API-Key + HMAC — kein Kunden-Token kam je durch, auch `/v1/customer/devices` nicht. Der Kunden-Router hängt jetzt davor.
- Die mobile App hatte außer der Geräteregistrierung KEINE Endpunkte; Katalog, Preis, Bestellung und Rechnung lagen nur hinter der Tenant-API (die nie in eine App darf). Neu unter `/v1/customer`: `me`, `products`, `products/{id}`, `quotes`, `orders` (GET/POST), `orders/{id}`, `confirm`, `cancel`, `orders/{id}/invoice` — Vertrag aus dem Frontend-Plan (PR #6), in OpenAPI beschrieben.
- Bestellungen laufen über `services/customer-orders.ts`, gemeinsam mit MCP. Eigentum: fremd = 404. Sichtbarkeit (G3) als Positivliste `toCustomerView` — MCP gab vorher das volle interne Dokument aus.
- Kunden stornieren nur Entwürfe und angehaltene Bestellungen; bestätigte gehören dem Händler (Gutschrift, D03).
- Idempotenz auf Kunden-Routen je KUNDE (`cust:<id>:<key>`); vorher hätte derselbe Schlüssel zweier Kunden die Antwort des einen an den anderen gegeben.
- M24 `clientVersionGuard` war gebaut, aber nirgends eingehängt — jetzt Pflicht auf allen Kunden-Routen.
- Nachweis: `pnpm smoke:customer` und `pnpm smoke:mcp` grün gegen Staging; `tests/routes/customer-api.spec.ts`.

## 2026-11-17 — erster echter Login per Mail

Login-Code über Cloudflare Email an ein reales Postfach zugestellt (SPF/DKIM/DMARC bestanden). `pnpm smoke:login` spielt den App-Ablauf durch: PKCE-Authorize, Token, Autorisierungscode nur einmal (410), Kunden-API, Refresh mit Rotation, altes Refresh-Token → 401 GH-AUTH-007. Mit diesem Token liefen `smoke:customer` und `smoke:mcp` bis zur Rechnung. Testkunde danach entfernt (E-Mail gelöscht, Tokens widerrufen). Stolperstein beim Anlegen: `INSERT OR IGNORE` verschluckte den Konflikt auf einer bereits vergebenen USt-IdNr. — Testdaten ohne `OR IGNORE` anlegen.
