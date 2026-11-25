# Central Error Catalog

Single Source of Truth für jeden Fehlercode in der App. Modulcode wirft
**ausschliesslich** Codes aus diesem Katalog. Neue Fehler → erst hier
registrieren, dann werfen.

## Code-Format

```
GH-<DOMAIN>-<NNN>
```

- `GH` — Project-Prefix (Grosshandel)
- `DOMAIN` — fester Bereich (siehe Tabelle)
- `NNN` — fortlaufende 3-stellige Nummer pro Domain

Codes sind **stabil für immer**. Deprecation: Code wird auf `status: deprecated`
gesetzt mit `replaced_by`-Hinweis, aber niemals wiederverwendet.

## Domains

| Domain    | Bereich                                          |
|-----------|--------------------------------------------------|
| `AUTH`    | API-Key, HMAC, Tokens, MCP-OAuth                 |
| `TENANT`  | Multi-Tenant-Isolation, Tenant-Bootstrap         |
| `IDEMP`   | Idempotency-Layer                                |
| `INPUT`   | Schema-Validierung am Rand                       |
| `CUST`    | Customer-Domain (Stammdaten)                     |
| `VIES`    | VAT-ID-Validierung gegen VIES                    |
| `PROD`    | Product/SKU/Catalog                              |
| `PRICE`   | Pricing Engine                                   |
| `TAX`     | Tax Engine                                       |
| `STOCK`   | Stock + Durable Objects                          |
| `ORDER`   | Order Document + Orchestrator                    |
| `RET`     | Retouren und Reklamationen                       |
| `STATE`   | State Machine (illegale Transitionen)            |
| `WEBH`    | Webhook-Delivery                                 |
| `MCP`     | MCP-Server-spezifisch                            |
| `EXT`     | Externe Systeme (buchhaltung_eu, whatsapp, …)    |
| `INFRA`   | D1, KV, R2, Queue, DO unerreichbar               |
| `RATE`    | Rate-Limits + Tier-Quotas (M15)                  |
| `CLIENT`  | Client-Version-Compat (M24)                      |
| `CRON`    | Scheduled Jobs (M17)                             |
| `FEED`    | Pricing-Feed-Import (M20)                        |
| `PERISH`  | Perishability + FEFO (M21)                       |
| `PDF`     | Invoice PDF Generation (M22)                     |
| `PUSH`    | Push Notifications (M23)                         |
| `OBS`     | Observability Sinks (M18)                        |
| `SECRET`  | Secrets Rotation (M16)                           |
| `DR`      | Disaster Recovery / Backup (M19)                 |

## Format eines Eintrags

Jeder Code als Tabellenzeile mit allen relevanten Feldern. Modulcode importiert
diese als TypeScript-Const-Map (`src/errors/catalog.ts`, generiert aus dieser Datei).

| Feld              | Bedeutung                                                   |
|-------------------|-------------------------------------------------------------|
| `code`            | siehe oben                                                  |
| `http_status`     | RFC-7807-Status (4xx/5xx)                                   |
| `category`        | `client_error` / `server_error` / `external_error`          |
| `retry`           | `none` / `exponential` / `manual`                           |
| `user_message`    | Text der dem Endkunden gezeigt werden darf (PII-frei)       |
| `internal_detail` | Was im Log/Audit steht (kann mehr verraten)                 |
| `observability`   | Log-Tag-Set für Alerting                                    |
| `status`          | `active` / `deprecated`                                     |

## Initial-Katalog

### AUTH

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-AUTH-001`   | 401  | none   | Authentifizierung fehlgeschlagen.     | Missing or unknown X-Api-Key             |
| `GH-AUTH-002`   | 401  | none   | Authentifizierung fehlgeschlagen.     | HMAC signature mismatch                  |
| `GH-AUTH-003`   | 401  | none   | Authentifizierung fehlgeschlagen.     | Timestamp outside 5min skew window       |
| `GH-AUTH-004`   | 403  | none   | Zugriff nicht erlaubt.                | Scope insufficient for operation         |
| `GH-AUTH-005`   | 401  | none   | Authentifizierung fehlgeschlagen.     | JWT/MCP token expired or revoked         |
| `GH-AUTH-006`   | 410  | none   | Code abgelaufen, bitte neuen anfordern.| Magic-link or authorization code expired |
| `GH-AUTH-007`   | 401  | none   | Sitzung ungültig, bitte neu anmelden. | Refresh-token replay detected — all customer refresh tokens invalidated |
| `GH-AUTH-008`   | 400  | none   | Ungültige Anmeldung.                  | PKCE code_verifier does not match challenge |

### TENANT

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-TENANT-001` | 404  | none   | Resource nicht gefunden.              | Cross-tenant access attempted (treat as 404, no leak) |
| `GH-TENANT-002` | 409  | none   | Tenant-Setup unvollständig.           | Tenant exists but missing required config |

### IDEMP

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-IDEMP-001`  | 409  | none   | Identische Anfrage mit anderem Inhalt.| Same idempotency key, different payload hash |

### INPUT

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-INPUT-001`  | 400  | none   | Ungültige Eingabe: {field}.           | Zod validation failure                   |
| `GH-INPUT-002`  | 413  | none   | Datei zu gross.                       | Upload exceeds tenant quota              |

### CUST

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-CUST-001`   | 404  | none   | Kunde nicht gefunden.                 | Customer id not found in tenant          |
| `GH-CUST-002`   | 409  | none   | Kunde existiert bereits.              | Duplicate customer (e.g. by VAT-ID)      |
| `GH-CUST-003`   | 422  | none   | Kunde ist gesperrt.                   | Customer.blocked=true                    |
| `GH-CUST-004`   | 422  | none   | Kreditrahmen überschritten.           | Order would exceed credit_limit          |

### VIES

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-VIES-001`   | 422  | none         | VAT-ID ungültig.                      | VIES returned invalid                    |
| `GH-VIES-002`   | 503  | exponential  | VIES-Service vorübergehend nicht erreichbar. | VIES timeout/5xx; cache fallback used (warn) |

### PROD

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-PROD-001`   | 404  | none   | Produkt nicht gefunden.               | SKU id unknown for tenant                |
| `GH-PROD-002`   | 422  | none   | Bestelleinheit nicht erlaubt.         | Requested unit not in product.packaging  |
| `GH-PROD-003`   | 422  | none   | Mindestbestellmenge unterschritten.   | qty < min_order_qty                      |

### PRICE

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-PRICE-001`  | 422  | none   | Kein Preis hinterlegt.                | No applicable price list for (customer, sku, date) |
| `GH-PRICE-002`  | 422  | none   | Preisliste abgelaufen.                | Price list valid_to < now                |

### TAX

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-TAX-001`    | 422  | none   | Steuerregel nicht ableitbar.          | No tax rule matches (tenant_country, customer_country, b2b/b2c, vat_status) |

### STOCK

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-STOCK-001`  | 409  | none         | Bestand nicht ausreichend.            | available < requested                    |
| `GH-STOCK-002`  | 410  | none         | Reservierung abgelaufen.              | reservation_id TTL exceeded              |
| `GH-STOCK-003`  | 503  | exponential  | Lager-Service vorübergehend nicht erreichbar. | Durable Object unreachable        |

### ORDER

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-ORDER-001`  | 404  | none   | Bestellung nicht gefunden.            | Order id unknown for tenant              |
| `GH-ORDER-002`  | 409  | none   | Bestellung wurde verändert.           | etag mismatch on update                  |
| `GH-ORDER-003`  | 422  | none   | Bestellung kann nicht bestätigt werden. | Gates not all passing                  |

### RET

| Code | HTTP | Retry | User-Message | Internal-Detail |
|---|---|---|---|---|
| `GH-RET-001` | 404 | none | Retourenfall oder Position nicht gefunden. | Case or position unknown or inaccessible |
| `GH-RET-002` | 409 | none | Der Vorgang ist im aktuellen Fallstand nicht möglich. | Case version, quantity, state or booking reference conflict |
| `GH-RET-003` | 503 | exponential | Die Übergabe wartet auf die Bestätigung des Lieferanten. | Supplier receipt unavailable, retry with the same command ID |

### STATE

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-STATE-001`  | 409  | none   | Übergang nicht erlaubt.               | Transition X→Y not in allowed_transitions |

### WEBH

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-WEBH-001`   | 502  | exponential  | (intern, kein User)                   | Receiver returned 5xx                    |
| `GH-WEBH-002`   | —    | none         | (intern, kein User)                   | Max retries exhausted, dead-letter       |

### MCP

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-MCP-001`    | 422  | none   | Position nicht eindeutig — bitte präzisieren. | SKU resolution confidence < threshold |
| `GH-MCP-002`    | 422  | none   | Bestätigung erforderlich.             | Agent attempted commit without confirm step |

### EXT

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-EXT-001`    | 502  | exponential  | Buchhaltung vorübergehend nicht erreichbar. | buchhaltung_eu unreachable          |
| `GH-EXT-002`    | 502  | exponential  | Externer Dienst nicht erreichbar.     | Generic external 5xx                     |
| `GH-EXT-003`    | 503  | manual       | Anmeldung per E-Mail ist derzeit nicht verfügbar. | No mail transport configured (EMAIL binding or MAIL_FROM missing outside development) |

### INFRA

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-INFRA-001`  | 503  | exponential  | Service vorübergehend überlastet.     | D1/KV/R2/Queue unreachable               |
| `GH-INFRA-002`  | 500  | none         | Interner Fehler.                      | Unexpected exception (Sentry-tagged)     |

### RATE

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-RATE-001`   | 429  | manual | Zu viele Anfragen, bitte später.      | Rate-limit bucket exhausted (class-level) |
| `GH-RATE-002`   | 429  | manual | Tarifgrenze erreicht.                 | Tenant tier quota exceeded               |

### CLIENT

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-CLIENT-001` | 426  | none   | Bitte App aktualisieren.              | Client version < min_supported, sunset reached |

### CRON

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-CRON-001`   | —    | manual       | (intern, kein User)                   | Scheduled job failed; auto-paused after 3 |

### FEED

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-FEED-001`   | 503  | exponential  | (intern, kein User)                   | Pricing feed endpoint unreachable        |
| `GH-FEED-002`   | —    | none         | (intern, kein User)                   | Pricing feed format invalid OR drift threshold breached |

### PERISH

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-FEFO-001`   | 422  | none   | Bestand mit ausreichender Restlaufzeit nicht verfügbar. | No batch matches min_shelf_life_days |
| `GH-PERISH-001` | 422  | none   | Bestand abgelaufen.                   | Batch already expired at reservation time |

### PDF

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-PDF-001`    | 500  | manual       | Rechnung konnte nicht erstellt werden.| Invoice PDF generation failed (validation, R2, lib OOM) |
| `GH-PDF-003`    | 404  | none         | Für diese Bestellung gibt es noch keine Rechnung. | Order has no invoice (not confirmed yet, or generation failed) |
| `GH-PDF-002`    | 422  | manual       | Rechnung kann nicht ausgestellt werden: Pflichtangaben des Verkäufers fehlen. | Tenant lacks vat_id and/or address (Art. 226 MwStSysRL); no invoice issued |

### PUSH

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-PUSH-001`   | 502  | exponential  | (intern)                              | APNs/FCM provider unreachable            |
| `GH-PUSH-002`   | —    | none         | (intern)                              | Device token invalid; auto-cleanup       |

### OBS

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-OBS-001`    | —    | none   | (intern)                              | Logging sink unreachable; fail-open with worker-logs backup |

### ADMIN

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-ADMIN-001`  | 401  | none   | Authentifizierung fehlgeschlagen.     | X-Admin-Key missing or wrong |
| `GH-ADMIN-002`  | 503  | manual | (intern)                              | ADMIN_API_KEY not configured on this worker; admin endpoints are off |
| `GH-ADMIN-003`  | 409  | none   | (intern)                              | Idempotency-Key already used for an issuance; the value is not handed out again |

### SECRET

| code            | http | retry  | user_message                          | internal_detail                          |
|-----------------|------|--------|---------------------------------------|------------------------------------------|
| `GH-SECRET-001` | 409  | none   | (intern)                              | Secret rotation conflict or generation failure |

### DR

| code            | http | retry        | user_message                          | internal_detail                          |
|-----------------|------|--------------|---------------------------------------|------------------------------------------|
| `GH-DR-001`     | —    | manual       | (intern)                              | Backup target unreachable or integrity-hash mismatch |

## Wie Modul-Files diesen Katalog nutzen

In jedem Modul-File unter „Error Paths":

```markdown
## Error Paths

| Symptom                            | Code            | Recovery |
|------------------------------------|-----------------|----------|
| API-Key fehlt im Header            | `GH-AUTH-001`   | 401, kein Retry |
| Mengenstaffel nicht ladbar (D1)    | `GH-INFRA-001`  | Retry exponential |
```

Niemals neuen Code im Modul-File definieren — immer hier hinzufügen.

## Beobachtbarkeit

Jeder Worker emittiert beim Werfen eines Codes ein strukturiertes Log-Event:

```json
{
  "level": "warn|error",
  "code": "GH-AUTH-002",
  "category": "client_error",
  "tenant_id": "...",
  "request_id": "...",
  "route": "POST /orders",
  "internal_detail": "..."
}
```

Aggregations-Regel: ein Sprung in `code`-Häufigkeit triggert Alerting (welcher
Schwellwert pro Code → in `_self-optimization.md` werden hier Learnings ergänzt).
