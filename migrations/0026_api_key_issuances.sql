-- Ausgaben eines Tenant-API-Keys über den Admin-Endpunkt (Business Manager,
-- Zieltyp „remote-mint“). Ein Idempotency-Key gilt genau einmal: ein zweiter
-- Aufruf mit demselben Schlüssel bekommt 409 und KEINEN Wert — der erste ist
-- in der Antwort einmalig herausgegangen und wird hier nicht aufbewahrt.

CREATE TABLE api_key_issuances (
  idempotency_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  api_key_id TEXT NOT NULL,
  rotated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX api_key_issuances_tenant ON api_key_issuances (tenant_id, created_at);
