# Security Policy

## Reporting Security Issues

Wenn du eine Sicherheitslücke entdeckst, **melde sie nicht öffentlich** über
GitHub-Issues oder Pull-Requests.

Stattdessen:
1. Meldung über **den privaten Meldeweg von GitHub (Security → „Report a vulnerability“).
2. Beschreibung mit Reproduktionsschritten, betroffener Worker-Version (`/health`),
   und vermutetem Impact.
3. Wir bestätigen den Eingang innerhalb 48h.
4. Triage + Fix-ETA innerhalb 5 Werktagen für High/Critical, 14 Werktagen für Low/Medium.
5. Coordinated Disclosure: 90d-Window für Veröffentlichung, kürzbar bei aktiver Ausnutzung.

## Scope

**In-Scope:**
- API-Endpoints unter `*.grosshandel.app/v1/*` und `/mcp`
- Authentication-Flows (HMAC, OAuth 2.1 + PKCE, Magic-Link, JWT)
- Multi-Tenant-Isolation
- Webhook-Delivery + Signature-Verification
- Order-Document-Schema und Orchestrator-Logik
- Stock-DO + Invoice-Number-DO Atomicity-Garantien

**Out-of-Scope:**
- DDoS auf öffentliche Endpoints (nutzt Cloudflare-Edge-Schutz)
- Brute-Force ohne Rate-Limit-Bypass-Demo
- Selbst-XSS auf Demo-Seiten ohne realer Impact
- Phishing-Versuche gegen Tenant-Operators
- Social-Engineering

## Bekannte Schwachstellen-Klassen + Mitigation

| Vektor | Mitigation |
|---|---|
| Replay-Attack auf API-Calls | HMAC inkl. Pfad+Query-String, ±5min Skew + KV-Replay-Cache |
| Brute-Force auf Auth | Rate-Limit-DO (Single-Writer, kein eventual-consistent Burst) |
| JWT-Algorithmus-Confusion | Hard-coded HS256-Verify, `iss`-Pin, ±60s Clock-Skew, future-iat-Reject |
| JWT-Secret-Rotation | `kid`-Header + Doppel-Reader (current/previous) für 7d Karenz |
| Refresh-Token-Diebstahl | Family-Replay-Detection, ALL Tokens revoked bei Replay; Customer-Status-Check beim Refresh |
| Cross-Tenant-Leak | tenant_id-Filter in jedem Repo-Aufruf, 404 statt 403 |
| SQL-Injection | Drizzle-ORM mit prepared statements; LIKE-Wildcards explizit escaped |
| PII-Leak in Logs | Auto-Redaction via Field-Pattern, deterministic sha256-Tag |
| Order-State-Race | etag-CAS auf Update, Outbox-Tx-Atomicity via db.batch |
| DO-Concurrency | `blockConcurrencyWhile` auf alle state-mutierenden Pfade |
| Webhook-SSRF | URL-Whitelist (https + public IPs); Block private/loopback/CGNAT |
| Webhook-Replay | HMAC inkl. Timestamp + canonical JSON; Receiver-Doku verlangt freshness-check |
| Idempotency-In-Flight-Race | D1-Lock-Tabelle (UNIQUE PK) + KV-Cache-Layer |
| DSGVO-"Vergessenwerden" | Pseudonymisierungs-Endpoint + 30d Backup-Retention |
| Pagination-Tampering | HMAC-signierter Cursor, env-version-bound |
| Image-Upload-XSS/SVG | Content-Type-Whitelist (`png/jpg/webp/gif`), kein SVG |
| Prompt-Injection (MCP) | sanitizeForLlm: Newlines/Brackets stripped, Length-Cap |

## Hash-Algorithm + Key-Management

- API-Keys: sha256 als Hash in DB, Klartext nur einmal beim Bootstrap
- Customer-JWT: HS256 mit per-Tenant-Secret (rotierbar mit 7d Karenz)
- Webhook-Signatures: HMAC-SHA256 mit per-Subscription-Secret
- Magic-Link-Codes: 8-Char-Crockford-Base32 (40 Bit Entropie), 10min TTL
- Refresh-Tokens: opaque ULID-Format `gr_<24-byte-base64url>`, sha256-Hash in DB

## Compliance

- **DSGVO Art. 17 (Recht auf Vergessen)**: `POST /v1/dsgvo/pseudonymize-customer`
  ersetzt PII (name, email, phone, addresses) im `customers`-Master durch
  deterministische sha256-Tags. Customer-ID, tenant-Beziehung und Bestellungen
  bleiben referenziert.
- **DSGVO Art. 15 + Art. 20 (Auskunft + Datenübertragbarkeit)**:
  `GET /v1/dsgvo/customer-export/:id` liefert ein selbst-konsistentes JSON-Bundle
  (Customer + Orders + Invoices + Devices).
- **Order-Snapshot-Retention (#P-008)**: `customer_snapshot` in `orders` enthält
  Name/VAT-ID/Country zum Bestellzeitpunkt. Diese werden bei Pseudonymize NICHT
  überschrieben — §147 AO + §257 HGB verlangen 10y Aufbewahrung von Rechnungs-
  daten. Operator muss dies in der DSGVO-Antwort an den Betroffenen offenlegen.
- **Backup-Retention (#P-007)**: R2-Backups 30d via `purgeOldBackups`-Cron.
  Backups älter als 30d werden gelöscht, damit pseudonymisierte PII nicht
  unbegrenzt persistiert.
- **Audit-Trail**: Order-Document trägt vollständige Decision-History
- **PCI-DSS**: nicht relevant für v1 (kein Stripe-Integration)
- **§203 StGB / §17 UWG**: Tenant-Isolation gewährleistet

## Out-of-Code Maßnahmen (Operator-Verantwortung)

Folgende Schutzmaßnahmen sind nicht im Code, sondern müssen vom Operator
beim Deploy konfiguriert werden:

1. **Cloudflare WAF + Bot-Management** auf der Worker-Route
2. **Logpush** nach R2 (30d hot, 7y cold)
3. **Geo-Restrictions** (falls Tenants nur in EU operieren)
4. **TLS/HTTPS-Only** (CF Default, aber prüfen)
5. **Secrets-Rotation-Cadence**: 90d default via `M16_secrets_rotation`
6. **Backup-Encryption-at-Rest** in R2 (CF default, aber dokumentieren)
7. **Pen-Test** vor Production (mind. jährlich)
8. **Bug-Bounty-Programm** nach 3 Monaten Live

## CI Security-Scans

Automatisch in `.github/workflows/`:
- `ci.yml` → `pnpm audit --prod --audit-level=high` (fails CI bei high/critical)
- `ci.yml` → `gitleaks` für Secret-Scan in jedem Commit
- `ci.yml` → `semgrep ci` mit OWASP-Top-10-Rules
- `codeql.yml` → GitHub CodeQL TypeScript-Analyse, weekly + on-PR

## Bekannte Limitationen (Plan-Revision-Kandidaten)

Diese Punkte sind aus dem 2026-05-02-Audit (`docs/AUDIT-2026-05-02.md`) als
bewusst akzeptierte Restrisiken oder Architektur-Aufgaben eingestuft:

- **#S-005 FEFO Per-Batch-Tracking**: Stock-DO ist Single-Counter; FEFO-Allocation
  wird advisory pre-Reservation berechnet, nicht authoritativ persistiert. Bei
  hoher Concurrency auf MHD-kritischen Produkten kann die Allocation drift'en.
  Mitigation: Reservation-TTL (2h) + Cron-FEFO-Recheck. Plan-Revision für v2.
- **#M-005 Multi-Currency / FX**: Schema hat `totals.fx_snapshot`, aber Worker
  setzt es nicht. Single-Currency-Annahme pro Tenant. FX-Engine ist Plan-Revision-
  Kandidat sobald Multi-Country-Tenants existieren.
- **#I-007 NAT-Fingerprint**: Pre-Auth-Rate-Limit kollabiert bei Corporate-NAT
  auf eine IP. Aktuell akzeptiert (Magic-Link 3/min macht Brute-Force eh
  unrealistisch). Future: User-Agent-Hash als Tiebreaker.
- **#Q-005 tax_rules.tenant_id NULL-Bedeutung**: NULL = globale Default-Regel,
  ein konkreter `tenant_id`-Wert = Tenant-Override. Resolver merged via
  `OR(eq, isNull)`. Operator MUSS sicherstellen, dass tenant-spezifische Regeln
  immer einen `tenant_id`-Wert tragen.
- **#A-014 HMAC-Replay-Cache**: KV-basiert, daher eventual-consistent. Ein
  Replay innerhalb von ~1s könnte beide den Cache gleichzeitig auf "miss" sehen.
  Akzeptiert, weil zwei identische gültige Signaturen mit gleichem Timestamp
  selbst ohne Cache eh wirkungsgleich wären.

## Vendor Security

- **Cloudflare** (Workers, D1, KV, R2, Queues, DOs): SOC 2 Type II
- **Resend** (Email-Versand): SOC 2, GDPR-konform
- **VIES** (EU VAT-Validation): EU-Kommission, kein DPA nötig
