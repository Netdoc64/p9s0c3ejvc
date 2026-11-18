# Runbook — KV unerreichbar

**Trigger:** `X-Idempotency-Warning: kv_unavailable` Response-Header > 0 in 5min, oder `GH-INFRA-001` Spike.

## Auswirkungen

- **Idempotency-Layer fail-open** (Spec): Doppel-POSTs mit gleichem Key gehen durch. Receiver muss dedupen.
- **VIES-Cache fail-open**: jeder Customer-Lookup geht direkt an VIES → Latency-Spike.

## Schritte

1. CF-Status checken — KV-Outage in welcher Region?
2. Wenn breit: Statusseite updaten, Tenant-Comms ggf.
3. Wenn lokal: Region-Routing prüfen.

## Mitigation

- Kritische write-Endpoints (POST /orders) temporär aussetzen falls Doppel-Effekte unakzeptabel sind. **Default ist fail-open** — kein Auto-Block.
- Workers ggf. region-restricten falls regional gestört.
