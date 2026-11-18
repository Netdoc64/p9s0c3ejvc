# Runbook — Auth-Failure Spike

**Trigger:** `rate(GH-AUTH-* per tenant_id over 5m) > 10x baseline`

## Klassifikation

- **GH-AUTH-001 (unknown key)** Spike → entweder Brute-Force oder Tenant-Misconfig
- **GH-AUTH-002 (HMAC mismatch)** Spike → Client benutzt falschen Secret (Rotation?)
- **GH-AUTH-003 (skew)** Spike → Client-Clock falsch
- **GH-AUTH-007 (refresh-replay)** → potentielles Account-Take-Over

## Erste 5 Minuten

1. Welcher Code dominiert?
2. Welcher Tenant? Welche Client-IPs?
3. Bei `GH-AUTH-007` → SOFORT alle Refresh-Tokens des Customers invalidieren (geschieht automatisch via M02b — verifizieren).

## Sofortmassnahme

- Bei externem Brute-Force: Cloudflare-Rate-Limit auf API-Pfaden global hochziehen
- Bei Tenant-Misconfig: Tenant kontaktieren, ggf. neuen API-Key ausstellen (M16-Rotation)

## Folge

- Postmortem mit Tenant teilen
- Bei wiederholten Replay-Versuchen: Customer-Account temporär sperren
