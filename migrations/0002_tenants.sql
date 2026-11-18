-- M02 / M03 — Tenants + API-Keys
-- Tabellen werden hier eingeführt damit M02 Auth-Middleware bauen kann.
-- M03 fügt Bootstrap-CLI + Repo-Wrapper darauf.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,           -- ISO-3166 alpha-2
  currency TEXT NOT NULL,          -- ISO-4217
  customer_jwt_secret TEXT NOT NULL, -- für M02b
  status TEXT NOT NULL DEFAULT 'active', -- active | deleted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,    -- sha256(plain_key)
  hmac_secret TEXT NOT NULL,        -- shared HMAC secret (per-key)
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0002_tenants', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
