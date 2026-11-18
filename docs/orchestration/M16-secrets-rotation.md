---
module_id: M16_secrets_rotation
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M16 — Secrets Rotation

## Goal

Geplante und ad-hoc Rotation aller geheimen Schlüssel ohne Downtime: Tenant-HMAC-Secret,
Tenant-JWT-Secret, externe API-Keys (Resend, später Stripe), Webhook-Sign-Secrets.

## Non-Goals

- Kein vollwertiges KMS (HSM-backed) — CF-Workers-Secrets + per-Tenant-Spalten reichen
- Keine User-Passwort-Rotation-Pflicht (M02b)
- Keine Encryption-at-Rest-Key-Rotation (D1 macht das transparent)

## Success Criteria

- Tenant-HMAC kann gewechselt werden ohne dass aktive B2B-API-Clients fehlschlagen
- Tenant-JWT-Secret kann gewechselt werden, in Umlauf befindliche JWTs bleiben gültig bis Ablauf
- Rotation läuft per Cron (90-Tage-Default) oder manuell via CLI
- Doppel-Reader-Phase mindestens 7 Tage (überschneidende Validity-Fenster)

## Execution Intent (Vibe)

- **Doppel-Reader-Pattern überall.** Während Rotation:
  - `current_secret` + `previous_secret` (beide gültig)
  - Reader probiert `current` zuerst, fallback `previous`
  - Nach Karenzfrist: `previous` wird gelöscht
- **Schreiber nutzt immer `current`.**
- **Externe Keys** (Resend etc.): Tenant-Setting mit `current_key` +
  `previous_key`, Adapter probiert in dieser Reihenfolge.

## Inputs Required

- M03 (tenants — Schema-Erweiterung um Doppel-Secret-Spalten)
- M17 (Cron-Worker — triggert Rotation)

## Deliverables

```
migrations/00XX_secrets.sql            tenants.hmac_secret_previous, jwt_secret_previous, *_rotated_at, *_previous_until
src/services/secrets.ts                getActive, getValid (current + previous während Karenz)
src/services/rotation.ts               rotate(tenant_id, secret_name) → schreibt current→previous, generiert neues
scripts/rotate-secrets.ts              CLI für ad-hoc
tests/services/rotation.spec.ts
```

## Happy Path

1. Cron-Trigger oder CLI-Aufruf: `rotate(tenant_id, "hmac_secret")`
2. Service: `previous = current; current = generate(); previous_until = now + 7d`
3. Auth-Middleware (M02) liest beide Secrets, akzeptiert HMAC mit beiden
4. Nach 7 Tagen: Cron-Cleanup setzt `previous = NULL`
5. Tenant-Operator wird via Webhook-Event `secret.rotated` informiert (kann
   eigene Backends aktualisieren)

## Error Paths

| Symptom                                  | Code             | Recovery |
|------------------------------------------|------------------|----------|
| Rotation während laufender Rotation       | `GH-SECRET-001`  | 409; Doppel-Rotation verboten |
| Generate-Fehler (CSPRNG)                 | `GH-SECRET-001`  | Retry; Alert |
| Cleanup vergisst `previous` zu löschen   | (Cron-Audit)     | Cleanup-Job mit Retry |

## Fallbacks

- Wenn Rotation fehlschlägt mitten drin: `previous` bleibt aktiv; `current`
  unverändert. Idempotent: Re-Run macht weiter wo aufgehört.

## Backwards-Compat Implications

- Doppel-Secret-Spalten permanent additiv
- `secret.rotated`-Event-Topic permanent
- Karenzfrist (Default 7d) als Tenant-Setting konfigurierbar

## Open Questions

- [x] ~~Karenzfrist?~~ → **7 Tage Default, Tenant-überschreibbar 1-30 Tage**
  (2026-04-28). Reason: Webhook-Subscriber haben realistisch Tage zum Neudeployen,
  nicht Stunden.
- [x] ~~Auto-Rotation oder nur manuell?~~ → **90-Tage-Cron Default + manueller
  Override** (2026-04-28). Reason: Compliance-Best-Practice (NIST: max 1 Jahr,
  praktisch quartalsweise).

## Observability

- Counter `secret.rotation.success` / `secret.rotation.failed`
- Gauge `secrets.in_grace_period` (sollte zeitnah → 0 zurück)

## Test Strategy

- Rotation-Roundtrip: alter HMAC funktioniert, neuer auch, beides parallel 7 Tage
- Cleanup-Test: nach Karenz wird `previous` entfernt
- Concurrent-Rotation-Versuche → genau einer durchkommt

## Learnings

→ `learnings/M16-secrets-rotation.log.md`

## Plan Revisions Originating Here

(initial leer)
