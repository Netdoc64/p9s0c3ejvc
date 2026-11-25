# Production einrichten (Schritte für den Menschen)

Diese Anleitung beschreibt, was **ein Mensch** im Cloudflare-Konto, im
Schlüsselspeicher und in den GitHub-Einstellungen erledigt, bevor der manuelle
Prod-Workflow laufen darf. Agenten legen keine Ressourcen an, tragen keine
Geheimnisse ein und deployen nicht.

> Diese Datei liegt bewusst **nicht** unter `docs/runbooks/`: der Drift-Test
> `tests/observability/alerts-drift.spec.ts` verlangt dort zu jedem Runbook
> einen Alert.

Das Repo ist öffentlich. Hier stehen deshalb nur Namen, nie Werte, und nur
Platzhalter-Domains wie `example.com`.

## Überblick

| Schritt | Wo | Ergebnis |
|---|---|---|
| 1 | Cloudflare | D1, KV, R2, Queues, Email Sending angelegt |
| 2 | Pull Request | echte IDs in `[env.production]` von `wrangler.toml` |
| 3 | Schlüsselspeicher / GitHub | Secrets und Variablen verteilt |
| 4 | GitHub | Environment `production` mit Pflicht-Review |
| 5 | Lokal | `node scripts/check-prod-config.mjs` liefert Exit 0 |
| 6 | Cloudflare (Migrationen) | Schema in `grosshandel-prod` |
| 7 | GitHub Actions | erster Deploy über `deploy-production.yml` |

## 1. Ressourcen im Cloudflare-Konto anlegen

Die Namen stehen schon in `[env.production]`; sie müssen exakt so angelegt
werden. Anmelden mit `npx wrangler login` (oder einem Token mit passenden
Rechten) im eigenen Terminal.

| Ressource | Name | Befehl |
|---|---|---|
| D1 (Region `weur`) | `grosshandel-prod` | `npx wrangler d1 create grosshandel-prod --location weur` |
| KV-Namespace | z. B. `grosshandel-kv-prod` | `npx wrangler kv namespace create grosshandel-kv-prod` |
| R2-Bucket | `grosshandel-assets-prod` | `npx wrangler r2 bucket create grosshandel-assets-prod` |
| Queue | `grosshandel-outbox-prod` | `npx wrangler queues create grosshandel-outbox-prod` |
| Dead-Letter-Queue | `grosshandel-outbox-prod-dlq` | `npx wrangler queues create grosshandel-outbox-prod-dlq` |

Die Befehle geben die **D1-`database_id`** und die **KV-`id`** aus; notiere sie
für Schritt 2. Beide sind keine Geheimnisse, gehören aber nicht in diese
Anleitung.

### E-Mail-Versand (Login-Codes)

Der Worker sendet Login-Codes über Cloudflare Email Service (Binding `EMAIL`,
`[[env.production.send_email]]`).

1. Im Cloudflare-Dashboard Email Sending für die Absender-Domain aktivieren
   und die verlangten DNS-Einträge (SPF, DKIM, DMARC) setzen.
2. Die Absenderadresse (z. B. `login@example.com`) wird später als
   Worker-Variable `MAIL_FROM` gesetzt (Schritt 3).

Fehlen `EMAIL` oder `MAIL_FROM` außerhalb von `development`, antwortet
`/magic-link/request` mit `GH-EXT-003`.

## 2. IDs in `wrangler.toml` eintragen (per PR)

In `[env.production]` die Platzhalter ersetzen:

| Schlüssel | Platzhalter | Eintragen |
|---|---|---|
| `d1_databases.database_id` | `00000000-0000-0000-0000-000000000000` | ID aus `d1 create` |
| `kv_namespaces.id` | `0000…0000` | ID aus `kv namespace create` |

Das geht als normaler Pull Request gegen `main` (Review wie üblich). Die
Bindings für `ASSETS`, `OUTBOX_QUEUE` (Producer und Consumer samt
Dead-Letter-Queue), `EMAIL` und die fünf Durable Objects (`STOCK_DO`,
`CRON_LOCK_DO`, `INVOICE_NUMBER_DO`, `RATE_LIMIT_DO`, `RETURNS_DO`) stehen
bereits im Block und bleiben unverändert.

## 3. Secrets und Variablen verteilen

Geheimnisse gehören dem **Schlüsselspeicher** (Business Manager). Nie von Hand
in Dateien schreiben oder aus Dateien zurücklesen; verteilt wird über den
Reiter „Schlüssel“. Hier stehen nur die Namen.

### Deploy-Zugang (GitHub-Environment `production`)

| Name | Art | Zweck |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | wrangler: Migrationen und Deploy; Rechte nur auf Workers, D1, KV, R2, Queues **genau eines** Kontos. Eine Konto-ID braucht es nicht: bei einem Token für genau ein Konto ermittelt wrangler es selbst, und die ID steht so in keinem öffentlichen Log |

Sie werden im Environment `production` hinterlegt, nicht als Repository-Secret,
damit nur der geprüfte Prod-Lauf sie sieht. Das Token ist ein eigenes für
Production, nicht dasselbe wie für Staging.

### Worker-Variablen und -Secrets

Diese Namen liest `src/env.ts`. Pflicht ist, was die Anwendung zum Betrieb
braucht; optional sind die Lieferanten-Anbindungen.

| Name | Pflicht | Art | Zweck |
|---|---|---|---|
| `MAIL_FROM` | ja | Variable | Absenderadresse der Login-Codes (Domain aus Schritt 1) |
| `CUSTOMER_APP_ORIGINS` | ja, sobald die Kunden-App läuft | Variable | Komma-Liste erlaubter Web-Origins für `/v1/customer/*` (CORS) |
| `STAFF_APP_ORIGINS` | ja, sobald das Händler-Dashboard läuft | Variable | Komma-Liste erlaubter Web-Origins für den Tenant-Bereich `/v1/*` mit Mitarbeiter-Token (CORS) |
| `FLORIDAY_CONNECTIONS` | nein | Variable | Lieferanten-Anbindung |
| `KOMANDER_CONNECTIONS` | nein | Variable | Lieferanten-Anbindung |
| `FLEUROP_NL_CONNECTIONS` | nein | Variable | Lieferanten-Anbindung |
| `FSN_CONNECTIONS` | nein | Variable | Lieferanten-Anbindung |
| `ADMIN_API_KEY` | nein | Secret | Schlüssel für `/admin/*` (nur der Schlüsselspeicher ruft das). Fehlt er, sind die Admin-Endpunkte aus (503), nicht offen. Mindestens 32 Zeichen |

`ENVIRONMENT` und `WORKER_VERSION` stehen in `wrangler.toml`, `GIT_COMMIT`
setzt der Deploy-Workflow selbst. Weitere Secrets, die ein Lieferant oder eine
Integration verlangt, stehen in `docs/supplier-integrations.md`.

Die Verteilung selbst (Prägen, Planen, Verteilen) macht ein Mensch im
Schlüsselspeicher; ein Agent bereitet höchstens Plan und Vorflug vor.

### Tenant-API-Keys ohne Klartext

`scripts/bootstrap-tenant.ts` gibt API-Key und HMAC-Geheimnis im Klartext im
Terminal aus. Für einen echten Tenant gibt es deshalb einen zweiten Weg:

```
POST /admin/tenants/<slug>/api-keys
X-Admin-Key: <ADMIN_API_KEY>
Idempotency-Key: <eindeutig je Vorgang>
```

Die Antwort trägt `value` (`<api_key>.<hmac_secret>`, getrennt am ersten Punkt)
und `fingerprint` (sha256 hex, 12 Zeichen) **genau einmal**. Derselbe
Idempotency-Key ein zweites Mal ergibt 409 ohne Wert. Je Tenant gibt es einen
Key dieser Herkunft (Name `business-manager`); eine neue Ausgabe dreht ihn, der
alte gilt noch 24 Stunden. Das ist der Vertrag des Zieltyps „remote-mint“ im
Schlüsselspeicher: er ruft an, verwahrt den Wert und verteilt ihn weiter.

`GET /admin/tenants` (gleicher Schlüssel) ist die Selbstauskunft für den
Vorflug: Slug als `id`, dazu Name und Status, sonst nichts.

### Mitarbeiter (Händler-Dashboard)

Mitarbeiter melden sich per Mail-Code an und bekommen ein eigenes Token, das
neben dem HMAC-Key für `/v1/*` gilt (8 Stunden, kein Refresh). Kunden-Tokens
gelten dort nie, Mitarbeiter-Tokens nie in `/v1/customer/*`.

| Schritt | Aufruf |
|---|---|
| ersten Inhaber anlegen | `POST /admin/tenants/<slug>/staff` mit `X-Admin-Key`, Body `{ "email": … }` |
| Code anfordern | `POST /v1/auth/staff/code/request`, Header `X-Tenant-Slug`, Body `{ "email": … }` |
| Code einlösen | `POST /v1/auth/staff/code/verify`, Body `{ "email", "code" }` → `access_token` |
| Leute verwalten (nur Inhaber) | `GET/POST /v1/staff`, `DELETE /v1/staff/<id>` (sperrt sofort) |

## 4. GitHub-Environment `production`

Einstellungen → Environments → *New environment* → Name **`production`**:

1. *Required reviewers*: mindestens eine verantwortliche Person eintragen
   (Pflicht-Review vor jedem Lauf).
2. *Deployment branches*: nur `main`.
3. Die Secrets aus Schritt 3 hier hinterlegen.

Ohne dieses Environment darf der Prod-Workflow nicht benutzt werden.

## 5. Konfiguration prüfen

```powershell
node scripts/check-prod-config.mjs
```

Vertrag des Skripts:

| Zustand von `[env.production]` | Exit-Code |
|---|---|
| Platzhalter-IDs (`0000…`) oder fehlende Bindings | **1**, mit Liste der Fehler |
| alle IDs echt, alle Bindings vorhanden | **0** |

Erst bei Exit 0 weitermachen. Der Deploy-Workflow ruft das Skript als ersten
Schritt selbst auf und bricht bei Exit 1 ab.

## 6. Migrationen anwenden

Die Migrationen unter `migrations/` (lückenlos ab `0001`) laufen gegen die
Prod-Datenbank:

```powershell
npx wrangler d1 migrations apply DB --remote --env production
```

Vorher mit `--list` ansehen, was ansteht:

```powershell
npx wrangler d1 migrations list DB --remote --env production
```

Der Befehl braucht `CLOUDFLARE_API_TOKEN` in der
Umgebung des Terminals (aus dem Schlüsselspeicher, nicht aus einer Datei).
Migrationen laufen vor dem Deploy und nie rückwärts; ein Fehler wird behoben,
indem eine neue Migration mit der nächsten freien Nummer entsteht.

## 7. Erster Deploy

Nur über den Workflow `.github/workflows/deploy-production.yml`:

1. GitHub → Actions → *Deploy Production* → *Run workflow* (`workflow_dispatch`,
   Branch `main`).
2. Die Prüfperson gibt den Lauf im Environment `production` frei.
3. Der Workflow führt `check-prod-config.mjs` aus und deployt erst bei Exit 0.

Nie lokal mit `wrangler deploy --env production` deployen.

### Nach dem Deploy

- `GET /health` auf der Prod-Domain antwortet `ok`.
- Login-Code anfordern: kommt die Mail an (sonst `GH-EXT-003`, siehe
  Schritt 1)?
- Cron-Läufe und Queue-Verzug im Dashboard beobachten; die Alarme und
  Runbooks unter `docs/runbooks/` gelten auch für Production.

## Checkliste

- [ ] D1 `grosshandel-prod` (weur), KV, R2 `grosshandel-assets-prod`, Queues `grosshandel-outbox-prod` und `-dlq` angelegt
- [ ] Email Sending und DNS für die Absender-Domain eingerichtet
- [ ] IDs per PR in `[env.production]` eingetragen und gemergt
- [ ] `CLOUDFLARE_API_TOKEN` im Environment `production`
- [ ] `MAIL_FROM` und `CUSTOMER_APP_ORIGINS` am Prod-Worker gesetzt
- [ ] Environment `production` mit Pflicht-Review
- [ ] `node scripts/check-prod-config.mjs` → Exit 0
- [ ] Migrationen angewendet
- [ ] Erster Deploy über den Workflow
