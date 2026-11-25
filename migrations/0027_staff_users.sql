-- Mitarbeiter eines Tenants (Händler-Dashboard). Sie melden sich per Mail-Code
-- an und bekommen ein eigenes Token (aud "grosshandel.staff"), das neben dem
-- HMAC-API-Key für den Tenant-Bereich /v1/* gilt. Kunden-Tokens gelten dort nie.

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE staff_login_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  staff_id TEXT NOT NULL REFERENCES staff_users(id),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX staff_login_codes_staff ON staff_login_codes (staff_id) WHERE consumed_at IS NULL;
