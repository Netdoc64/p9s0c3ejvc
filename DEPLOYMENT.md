# Deployment — Grosshandel auf Cloudflare Workers

Schritt-für-Schritt-Anleitung für Pilot-Tenant (Staging) und Production.

## Voraussetzungen

- Cloudflare-Account mit Workers Paid Plan (DOs + Queues)
- `wrangler` CLI lokal authentifiziert (`wrangler login`)
- Node 20+, pnpm 10+

## 1. CF-Resources anlegen

```bash
# D1 Database (Region: weur — lt. build-plan G2)
wrangler d1 create grosshandel-staging --location weur
wrangler d1 create grosshandel-prod --location weur

# KV Namespace
wrangler kv:namespace create grosshandel-kv-staging
wrangler kv:namespace create grosshandel-kv-prod

# R2 Bucket
wrangler r2 bucket create grosshandel-assets-staging
wrangler r2 bucket create grosshandel-assets-prod

# Queues (Outbox + DLQ)
wrangler queues create grosshandel-outbox-staging
wrangler queues create grosshandel-outbox-staging-dlq
wrangler queues create grosshandel-outbox-prod
wrangler queues create grosshandel-outbox-prod-dlq
```

Notiere die **D1-database_id** und **KV-id** — beide ersetzen die `00000000…`-Placeholder
in `wrangler.toml`. Erstelle dazu eine Environment-Override-Section pro Stage.

## 2. wrangler.toml ergänzen

```toml
[env.staging]
vars = { ENVIRONMENT = "staging" }

[[env.staging.d1_databases]]
binding = "DB"
database_name = "grosshandel-staging"
database_id = "<UUID-aus-Schritt-1>"
migrations_dir = "migrations"

[[env.staging.kv_namespaces]]
binding = "KV"
id = "<KV-ID-aus-Schritt-1>"

[[env.staging.r2_buckets]]
binding = "ASSETS"
bucket_name = "grosshandel-assets-staging"

[[env.staging.queues.producers]]
binding = "OUTBOX_QUEUE"
queue = "grosshandel-outbox-staging"

[[env.staging.queues.consumers]]
queue = "grosshandel-outbox-staging"
max_batch_size = 10
max_retries = 3
dead_letter_queue = "grosshandel-outbox-staging-dlq"

[[env.staging.durable_objects.bindings]]
name = "STOCK_DO"
class_name = "StockDO"

[[env.staging.durable_objects.bindings]]
name = "CRON_LOCK_DO"
class_name = "CronLockDO"

[[env.staging.durable_objects.bindings]]
name = "INVOICE_NUMBER_DO"
class_name = "InvoiceNumberDO"

[[env.staging.durable_objects.bindings]]
name = "RATE_LIMIT_DO"
class_name = "RateLimitDO"

# Analog für [env.production].* mit prod-IDs.
```

## 3. Secrets setzen

```bash
# Login-Codes gehen über Cloudflare Email Service (Binding `EMAIL` in
# wrangler.toml, kein API-Schlüssel). Nur die Absenderadresse fehlt — ihre
# Domain muss im Konto freigeschaltet sein (`wrangler email sending list`).
wrangler secret put MAIL_FROM --env staging
wrangler secret put MAIL_FROM --env production
# Ohne MAIL_FROM antwortet /v1/auth/magic-link/request mit 503 GH-EXT-003.
```

## 4. D1-Migrations applyen

```bash
# Staging
wrangler d1 migrations apply grosshandel-staging --remote --env staging

# Production
wrangler d1 migrations apply grosshandel-prod --remote --env production
```

Sollte die 18 Migrations ohne Fehler durchlaufen. Bei Konflikt: erst lokal in
miniflare verifizieren (`pnpm test`).

## 5. Deploy

```bash
# Staging
pnpm typecheck && pnpm test && pnpm build
wrangler deploy --env staging

# Production (NACH erfolgreichem Staging-Pilot)
wrangler deploy --env production
```

## 6. Bootstrap-Tenant (Pilot)

```bash
# Staging-Seed
GROSSHANDEL_BASE_URL=https://staging.api.grosshandel.app pnpm seed:pilot -- --remote --env staging
# → output: api_key + hmac_secret notieren! NUR beim ersten Lauf gültig:
#   ein zweiter Lauf gibt einen neuen Key aus, der nie gespeichert wird.

# Smoke-Test
GROSSHANDEL_BASE_URL=https://staging.api.grosshandel.app \
GROSSHANDEL_API_KEY=gh_... \
GROSSHANDEL_HMAC_SECRET=... \
  pnpm smoke

# Kunden-Login wie die App (Code vorher per /v1/auth/magic-link/request anfordern)
LOGIN_EMAIL=... LOGIN_CODE=... pnpm smoke:login

# MCP-Ablauf wie ein Client (Token aus /v1/oauth/token)
GROSSHANDEL_MCP_TOKEN=... pnpm smoke:mcp

# Bestand unter Last: N parallele Bestellungen auf K Stück
STRESS_SKU=sku_tulip_yellow_40 pnpm stress:stock
```

## 7. Logpush konfigurieren

`wrangler.toml` deklariert keine Logpush-Konfig (CF-Limitation). Manuell:

```bash
# Cloudflare Dashboard → Workers → grosshandel → Logs → Logpush
# Destination: R2 bucket `grosshandel-assets-prod/logs/`
# Filter: alle (initial), später nach `level >= warn` filtern
# Retention: 30d hot in R2, 7y cold-archive (eigener Lifecycle-Rule)
```

## 8. Webhook-Subscriptions für Tenants

Tenants registrieren ihre Webhooks via API:

```bash
curl -X POST https://api.grosshandel.app/v1/webhooks \
  -H "X-Api-Key: $TENANT_API_KEY" \
  -H "X-Signature: $HMAC_SIG" \
  -H "X-Timestamp: $UNIX_TS" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://erp.tenant.com/grosshandel-events","topic_filter":"order.*"}'
# → response: {id, signing_secret}
# Tenant speichert `signing_secret` und nutzt es in seinem Receiver zur HMAC-Verifikation.
```

## 9. SDK-Generierung für Konsumenten

Konsumenten-Backends nutzen die OpenAPI-Spec für SDK-Generierung:

```bash
# TypeScript
npx openapi-typescript https://api.grosshandel.app/openapi.json -o sdk/grosshandel.ts

# Python
openapi-python-client generate --url https://api.grosshandel.app/openapi.json
```

## 10. Monitoring + Alerts

`monitoring/alerts.json` ist deklarativ — manuell ins CF-Notification-Setup übernehmen,
ODER (Plan-Revision) via Terraform aufsetzen.

Runbooks: `docs/runbooks/*.md` werden im Incident konsultiert.

## 11. DR-Drill (jährlich)

```bash
# Wegwerf-DB, Schema, dann einen Stand zurückspielen (prüft Hashes, zählt nach)
wrangler d1 create grosshandel-drill --location weur
for f in migrations/*.sql; do wrangler d1 execute grosshandel-drill --remote --yes --file "$f"; done
pnpm tsx scripts/restore-d1.ts --bucket grosshandel-assets-prod   --prefix backups/d1/<datum>/<datum>-<stunde> --target grosshandel-drill --remote
wrangler d1 delete grosshandel-drill
```

Zuletzt auf Staging: 2026-11-17, 31 Tabellen / 144 Zeilen, alle Hashes und Zählungen grün, 3,5 min.

Siehe `docs/runbooks/disaster-restore.md`.

## Checkliste vor erstem echten Tenant

- [x] CF-Resources angelegt (Schritt 1) — Staging am 2026-11-17; Production offen
- [x] `wrangler.toml` mit echten IDs konfiguriert (Schritt 2) — Staging; Production offen
- [x] Secrets gesetzt (Schritt 3) — der Worker liest zur Laufzeit keine; Tenant-Schlüssel liegen in D1
- [x] Migrations applied (Schritt 4) — Staging, 0001–0021
- [x] CI grün auf `main` (`.github/workflows/ci.yml`)
- [x] Deployed nach Staging (Schritt 5)
- [x] Smoke-Test grün (Schritt 6) — inkl. Wareneingang, Confirm, Rechnung, Outbox zugestellt, Crons laufen
- [ ] Logpush aktiviert (Schritt 7)
- [x] Stress-Test: `pnpm stress:stock` — 100 parallele Bestellungen auf 50 Stück, genau 50 angenommen (Staging, 2026-11-17)
- [x] OAuth + MCP: `pnpm smoke:login` mit echtem Login-Code per Mail (Cloudflare Email, SPF/DKIM/DMARC bestanden) → PKCE, Token, Einmal-Einlösung, Rotation mit Replay-Erkennung; danach `smoke:customer` und `smoke:mcp` mit diesem Token bis zur Rechnung (Staging, 2026-11-17)
- [ ] Sec-Review (mindestens ein Engineer drüber)
- [x] Lasttest: `pnpm load` — 207 rps über 60 s bei 20 parallel, 0 % Fehler, p99 261 ms (Budget 500) (Staging, 2026-11-17)
- [x] Backup verifiziert: stündlicher Cron schreibt nach R2; Restore-Drill in Wegwerf-D1 grün (Staging, 2026-11-17). Offen: Bestand in Durable Objects ist nicht Teil des Backups

Erst danach `wrangler deploy --env production` und ersten echten Tenant onboarden.
