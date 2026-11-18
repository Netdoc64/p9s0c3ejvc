-- M04 — Customers + VIES-Cache

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_id TEXT,                       -- optional, vom Tenant
  name TEXT NOT NULL,
  email TEXT,                             -- pii
  phone TEXT,                             -- pii
  country TEXT NOT NULL,                  -- ISO-3166 alpha-2
  b2b_b2c TEXT NOT NULL,                  -- 'b2b' | 'b2c'
  vat_id TEXT,
  vat_status TEXT NOT NULL DEFAULT 'not_required', -- 'valid'|'invalid'|'unknown'|'not_required'
  vies_checked_at TEXT,
  language TEXT,
  credit_limit_cents INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0,
  addresses TEXT NOT NULL DEFAULT '{}',   -- JSON {billing, shipping?}
  metadata TEXT NOT NULL DEFAULT '{}',    -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_tenant_vat ON customers(tenant_id, vat_id) WHERE vat_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0004_customers', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
