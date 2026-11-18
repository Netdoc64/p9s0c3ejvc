# Threat Model — Grosshandel API

STRIDE-Analyse pro kritischem Flow. Stand: 2026-04-29.

**STRIDE:**
- **S** Spoofing — Identity gefälscht
- **T** Tampering — Daten manipuliert
- **R** Repudiation — Aktion abgestritten
- **I** Information Disclosure — Daten geleakt
- **D** Denial of Service
- **E** Elevation of Privilege

## 1. Tenant-API (HMAC + API-Key)

**Flow:** B2B-Backend ruft `/v1/customers`, `/v1/orders` etc. mit
`X-Api-Key + X-Signature + X-Timestamp`.

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **S**: Angreifer benutzt geleakten API-Key | HMAC verlangt zusätzlich Secret. Allein der Key reicht nicht. | Wenn beide leaken (Key+Secret), ist Tenant kompromittiert. → Rotation alle 90d (M16). |
| **S**: Replay einer signierten Request | Timestamp-Skew ±5min + Idempotency-Key (24h). | Replay innerhalb 5min mit gleichem Idempotency-Key gibt cached Response zurück (idempotent → kein Schaden). |
| **T**: Body-Tampering nach Signing | Body-sha256 ist Teil der Signatur. | Keine. |
| **R**: Tenant streitet Aktion ab | Alle Mutationen mit `request_id`, `api_key_id`, `actor` im Audit-Log. | Mid-tier — wenn Logpush nicht aktiv, gehen Logs nach 14d verloren. |
| **I**: Cross-Tenant-Read | `WHERE tenant_id = ?` in jedem Repo. 404 statt 403. | Programmierfehler in zukünftigen Routes — wird durch `cross-tenant`-Test in jedem Modul gefangen. |
| **D**: Brute-Force-Login | Rate-Limit `auth_login` 5/min DO-backed. | None observed. |
| **E**: Privilege-Escalation via Scope-Manipulation | Scope ist im JWT-Claim, signature-protected. | Keine wenn JWT-Verify korrekt. Kein "scope" im API-Key-Modell relevant. |

## 2. Customer-Auth (Magic-Link + OAuth + JWT)

**Flow:** Customer öffnet Mobile-App, gibt Email ein, kriegt 8-Char-Code per
Email, gibt ihn ein, kriegt JWT (15min) + Refresh (90d, rotierbar).

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **S**: Email-Enumerierung über Magic-Link-Request | `POST /magic-link/request` antwortet immer 200, unabhängig davon ob Email existiert. | Timing-Side-Channel theoretisch möglich (DB-Hit vs nicht), in CF-Workers durch Edge-Caching fast unmöglich auszunutzen. |
| **S**: Magic-Link-Code Brute-Force | 32^8 = 1 Trillion Possibilities, 5/min Rate-Limit, 10min TTL, 5 Versuche pro aktiver Code. | Praktisch ausgeschlossen. |
| **T**: JWT-Tampering | HS256-Signatur mit per-Tenant-Secret. Modifikation invalidiert Signatur. | Keine. |
| **T**: JWT-Algorithm-Confusion (alg:none) | Hard-coded HS256-Verify, alle anderen Algos rejected mit `wrong_alg`. | Keine. |
| **T**: Cross-Tenant-JWT (alter Tenant in Token, anderer im URL-Slug) | JWT-Verify prüft `tenant_id`-Claim gegen URL-Tenant → 404 wenn mismatch. | Test belegt. |
| **R**: Customer streitet Magic-Link-Verify ab | `auth_magic_link_tokens` mit `consumed_at` als Audit. Email-Versand-Log via Resend. | Plan-Revision: Login-Audit-Tabelle für längere Aufbewahrung. |
| **I**: Refresh-Token-Diebstahl + Replay | Family-Replay-Detection: alter Token → ALLE Family-Tokens revoked. | None observed. Customer muss neu anmelden, was korrekt ist. |
| **I**: PKCE-Verifier-Leak | code_verifier nur lokal beim Mobile-Client, niemals im Transit ausser im Token-Exchange. | Mobile-Client-Fehler: wenn Verifier in localStorage statt secure-storage, leakt bei Browser-Plugin-Compromise. → Doku-Punkt für SDK. |
| **D**: Magic-Link-Spam | Rate-Limit `magic_link_request` 3/min DO-backed pro Identifier. | None. |
| **D**: Login-Brute-Force pro Customer | Rate-Limit `auth_login` 5/min. Plus Family-Revocation bei Replay. | Distributed-Brute-Force über viele IPs könnte 5/min pro IP nutzen, aber Magic-Link-Code-Entropie macht das praktisch nutzlos. |
| **E**: Scope-Escalation | Scope `customer_self` im JWT-Claim, signature-protected. Tools mit `write`-Scope blocken bei `customer_self`-Token nicht — siehe MCP-Sektion. | Plan-Revision: separate `customer_self_readonly`-Scope für Read-Only-MCP-Tokens. |

## 3. MCP-Endpoint (AI-Agent)

**Flow:** Claude-Desktop verbindet via OAuth 2.1 + PKCE, ruft Tools
(`search_products`, `create_order_draft`, `confirm_order`).

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **S**: Halluzinierender Agent legt Bestellung an, die Customer nie wollte | **Two-Tool-Pattern**: `create_order_draft` ist non-committal, nur `confirm_order` committet. UI muss Customer dazwischen fragen. | Wenn UI das Pattern ignoriert, ist es Client-Fehler. Server kann nichts mehr tun. |
| **S**: Agent confirmt automatisch ohne Customer-Frage | `GH-MCP-002` wenn `confirm_order` direkt nach `create_order_draft` ohne Bestätigung-Step im Tool-Result. | Plan-Revision: stronger temporal enforcement (mind. 5s zwischen draft + confirm). |
| **T**: Agent manipuliert Tool-Args | Server-Side Zod-Validation. PKCE-Token kann nicht zu anderem Customer wechseln. | Keine. |
| **R**: Customer streitet Agent-Bestellung ab | Order-Doc trägt `audit.ai_decisions[]` mit Tool-Call-Sequenz. `actor.type=customer, source.channel=mcp`. | Mid-tier — Audit muss durch Logpush archiviert werden. |
| **I**: Agent leakt Customer-Daten an Modell-Anbieter | Tool-Output enthält Customer-PII. Bei OpenAI/Anthropic-Routes gehen die Daten zu deren Logs. | Plan-Revision-Kandidat: PII-Redaction in Tool-Results, optional pro Tenant. |
| **D**: Agent ruft Tool in Loop | Rate-Limit pro Tool nicht aktiv (nur HTTP-Level). | Plan-Revision: per-tool/per-customer Rate-Limits. |

## 4. Webhook-Delivery (Outbox → Tenant-Receiver)

**Flow:** State-Change emittet Event in Outbox, Queue-Consumer pusht an
Tenant-Subscription-URLs mit HMAC-Signatur.

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **S**: Angreifer ruft Tenant-Receiver mit gefälschtem Event | Receiver muss HMAC-Signatur prüfen mit `signing_secret`. | Tenant-Verantwortung wenn der Tenant die Verifikation nicht implementiert. → Doku in DEPLOYMENT.md. |
| **T**: Receiver kriegt Body-modifizierten Webhook | HMAC umfasst den Body. Modifikation invalidiert. | Keine. |
| **R**: Tenant streitet Empfang ab | `webhook_deliveries`-Tabelle mit Audit. | None. |
| **I**: Event-Payload enthält Customer-PII | Event-Payload IST das ganze Order-Doc — beinhaltet PII. Geht TLS-secured an Tenant-Receiver. | Akzeptables Risiko (Tenant ist Datenverarbeiter). |
| **I**: Signing-Secret leakt | Wird einmal bei Subscription-Create gezeigt, danach nicht mehr lesbar. | Wenn Tenant es leakt, kann Angreifer Webhooks fälschen. → Webhook-Secret-Rotation als Plan-Revision. |
| **D**: Tenant-Receiver down → Backlog | Backoff 1s..6h, max 6 Versuche, dann Dead-Letter. | None. |

## 5. D1 + KV + R2 (Storage)

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **I**: D1-Snapshot landet im falschen R2 | R2-Bucket-Permissions per Tenant nicht relevant (Single-Tenant-Bucket pro Stage). | Setup-Verantwortung: production-bucket nicht öffentlich, Cross-Region-Replikation aktivieren. |
| **I**: PII in Backup-jsonl | Backup enthält volle DB-Rows inkl. unhashed PII (für Restore). | Akzeptiert: Backup ist im selben Trust-Boundary wie D1. R2-bucket muss verschlüsselt-at-rest und nicht öffentlich sein. |
| **T**: Backup-Tampering | sha256-Hash in customMetadata. Restore-Skript verifiziert. | None. |
| **D**: D1 voll | Soft-limits CF: 10 GB pro DB. Bei Erreichen Plan-Revision auf D1-shard-pro-Tenant oder Postgres-Migration. | Plan-Revision-Trigger ab 7GB. |
| **D**: KV-Quota überschritten | Idempotency-Cache 24h TTL → self-cleaning. VIES-Cache 24h TTL. Rate-Limit-Buckets 90s TTL. | None observed for typical usage. |

## 6. Cron-Jobs

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **S**: Angreifer triggert Cron-Job manuell | `scheduled()`-Handler ist nur über CF-Cron-Trigger erreichbar, nicht öffentlich. | None. |
| **D**: Cron-Job läuft nicht (gestürzt) | Auto-Pause nach 3 consecutive failures. Alert via `cron.job.paused`-Gauge. | Operator-Verantwortung: Alert-Routing aktivieren. |
| **D**: Cron-Job läuft endlos | DO-Lock mit TTL releast den Lock nach `lock_ttl_sec`. Nächster Trigger nimmt frischen Lock. | None. |
| **E**: Cron-Job-Code wird kompromittiert | Worker-Deploy-Pipeline ist die einzige Mutation-Quelle. | Build-Time-Compromise (Supply-Chain) → CI Static-Analysis + Dependency-Audit. |

## 7. Rate-Limit-DO

| Threat | Mitigation | Restrisiko |
|---|---|---|
| **D**: DDoS auf Auth-Endpoints umgeht Rate-Limit | Strict-Klassen sind DO-backed (single-writer). Bei DO-Outage Fallback auf KV (eventual-consistent → marginales Burst-Risiko). | Mid-tier — KV-Fallback erlaubt theoretisch ~5 zusätzliche Requests in <1s. Akzeptiert. |
| **S**: Identifier-Spoofing (z.B. CF-Connecting-IP gefälscht) | CF-Edge setzt diesen Header zwingend, kann nicht clientseitig manipuliert werden. | None. |

## Aktualisierungs-Cadence

Threat-Model wird **alle 6 Monate** oder bei Major-Plan-Revisions reviewed.
Jeder neue Auth-Flow oder Storage-Layer braucht eigene STRIDE-Sektion.
