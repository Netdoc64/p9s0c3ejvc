# Production-Hardening — Plan-Revision

## 2026-04-29 — by claude-opus-4-7 (production-readiness pass)

### Auslöser
Honest assessment "ist das nun production-ready?" → Nein. 18 Showstopper, von denen
~10 in-code fixbar waren. Dieser Pass schliesst die in-code-fixbaren.

### Was geliefert wurde

#### Datenkorrektheit
1. **Invoice-Number-DO** (`src/do/invoice-number.ts`) — Single-Writer-DO pro Tenant für
   lückenlose Rechnungsnummern unter Concurrency. Yearly-Reset eingebaut.
   Ersetzt das D1-`invoice_number_seq`-Update das unter Race-Conditions Lücken erzeugen konnte.
2. **Outbox-Tx-Atomicity** — `repos/orders.update` schreibt jetzt UPDATE + outbox-INSERT in
   einem `db.batch([...])`. `emit_event`-Handler legt Events in `doc.external_refs._pending_emits`
   ab statt sofort zu schreiben. Race-Window zwischen state-change und event-insert geschlossen.
3. **API-Key Indexed Doppel-Reader** — Migration `0018_api_keys_previous_index.sql` legt
   eigenen Index auf `key_hash_previous` an. Auth-Lookup nutzt jetzt OR-Klausel auf zwei
   indexierten Spalten statt Full-Table-Scan. Skaliert mit ≥10k Tenants.
4. **FEFO-Advisory-Check** (`services/fefo.ts`) — Pre-Reserve-Check filtert Batches nach
   `min_shelf_life_days`. Bei perishable SKUs wirft `GH-FEFO-001` wenn keine Batch
   genug Restlaufzeit hat. Allocation-Plan landet in `line.resolution.fefo_allocations`.

#### Security
5. **DO-backed Strict-Rate-Limit** — `auth_login`, `auth_token_refresh`, `magic_link_request`
   gehen über `RateLimitDO` (Single-Writer-Garantie) statt KV (eventual-consistent).
   Brute-Force-Burst-Through-Risiko geschlossen.
6. **DSGVO-Pseudonymisierung** (`services/dsgvo.ts` + `POST /v1/dsgvo/pseudonymize-customer`) —
   ersetzt PII-Felder durch sha256-Tags, behält Customer-ID/Tenant-Beziehung für
   10y-Aufbewahrungspflicht. Audit-Log in `customer.metadata.dsgvo[]`.

#### Quality
7. **pdf-lib** — `services/invoice-pdf.ts` rendert echte PDFs mit Tabellen-Layout,
   Tenant-Header, Country-spezifischen Hinweisen (Reverse-Charge, Export). Mini-PDF-Stub
   als deprecated-Backup behalten.

#### Process
8. **RPO 6h** statt 23h — Backup-Cron auf `0 */6 * * *`. Plan-Revision: hourly wenn Quota erlaubt.
9. **`.env.example`** — alle erforderlichen Secrets dokumentiert (RESEND, APNs/FCM, Aalsmeer/RBC).
10. **`DEPLOYMENT.md`** — 11-Schritt-Anleitung von D1-create bis Production-Tenant-Onboarding,
    inkl. Pre-Production-Checkliste mit Stress-Test, Sec-Review, Lasttest, DR-Drill.
11. **`.github/workflows/deploy-staging.yml`** — Automatischer Staging-Deploy auf `main`-Push,
    falls Repository-Secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` gesetzt sind.
    Skip-with-Warning wenn nicht gesetzt.

### Was noch nicht production-ready ist (out-of-scope für in-code fix)

- **Echte CF-Resources**: D1/KV/R2/Queue-IDs müssen vom Operator angelegt werden.
- **Real APNs/FCM**: brauchen Apple-Team-ID / FCM-Service-Account-Key.
- **Aalsmeer/RBC-Adapter**: brauchen API-Access vom Pilot-Tenant.
- **Stock-DO Concurrent-Stress-Test**: vitest-pool-workers Windows-Bug; Linux-CI sollte funktionieren.
- **Lasttest gegen deployed Worker**: setzt Staging voraus.
- **Externe Sec-Review**: extern.

### Backwards-Compat
Alle Änderungen rein additiv:
- Neue DOs (`InvoiceNumberDO`, `RateLimitDO`) via `wrangler.toml [[migrations]] tag = "v2"`.
- Neue Migration 0018 (Index-only, kein Schema-Break).
- Neue Route `/v1/dsgvo/pseudonymize-customer`.
- `repos/orders.update` Return-Type erweitert um `emitted_event_ids` (additiv).
- Order-Doc `external_refs._pending_emits` ist ein internes Feld (mit `_`-Prefix), wird vor
  Persistierung wieder entfernt — nicht in finaler Doc-Persistenz sichtbar.

### Tests
95 passed + 1 skipped. Build green.

### Nächste Plan-Revisions (nicht jetzt nötig)
- pdf-lib mit Tenant-Logo aus R2
- Aalsmeer/RBC-Adapter
- Hourly-Backup wenn CF-Quota erlaubt
- Per-Batch FEFO-Allocation-Tracking (qty_remaining-Spalte)
- Real APNs/FCM (M23-Plan-Revision)
- Webhook-Configuration via Terraform

## Prod-Konfigpruefung (scripts/check-prod-config.mjs)
- Reine Funktion `pruefeProdConfig(tomlText)` + CLI (Exit 1 bei Befunden); kleiner TOML-Leser ohne Abhaengigkeit.
- Heute bewusst Exit 1: DB-`database_id` und KV-`id` in `[env.production]` sind Platzhalter (0000…).
- vitest laeuft im Workers-Pool (kein fs): Test liest wrangler.toml per `import.meta.glob(?raw)`; CLI laeuft nur als Hauptmodul.
