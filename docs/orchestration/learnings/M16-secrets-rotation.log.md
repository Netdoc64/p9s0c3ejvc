# M16 — Learnings

### What happened
Schema-Erweiterung: api_keys.{key_hash_previous, hmac_secret_previous, *_until}, tenants.{customer_jwt_secret_previous, *_until}. Service `src/services/rotation.ts` mit `rotateApiKey`/`rotateTenantJwtSecret`/`cleanupExpiredPreviousSecrets`. Auth-Middleware erweitert um Doppel-Reader (akzeptiert previous-Hash + previous-HMAC während 7d-Karenz). Cron-Job `secret-rotation-cleanup` (täglich 03:30) räumt abgelaufene previous-Werte weg.

### Decisions
1. **7d Karenz** wie Spec.
2. **Cron-Lookup statt KV-Cache**: Auth-Middleware lädt jetzt Mehrheit der api_keys (`isNull(revoked_at)`) statt Single-Hash-Lookup, da der Lookup über key_hash ODER key_hash_previous gehen muss. Plan-Revision-Kandidat: zwei separate indexierte Spalten + UNION-Query für skalierbares Lookup. Aktuell tolerabel bei wenigen tausend Tenants (jeweils 1-3 Keys).
3. **Manuelle Rotation via Service-Funktion** — CLI-Wrapper analog zu bootstrap-tenant ist Plan-Revision-Kandidat (kann nachgereicht werden).
4. **`secret.rotated`-Webhook-Topic** wird bei der Outbox-Implementation (M12) emittiert; Rotation-Service kann das nach `outbox.emit` aufrufen sobald M12 da ist.
