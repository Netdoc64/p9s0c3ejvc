-- M02b — Customer Auth (OAuth 2.1 + PKCE + JWT + Magic-Link)

CREATE TABLE IF NOT EXISTS auth_authenticators (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL,                       -- 'magic_link' | 'password' | 'passkey'
  identifier TEXT NOT NULL,                 -- email, phone, passkey-id
  secret_hash TEXT,                         -- argon2id für password, NULL für magic_link
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_authenticators_customer ON auth_authenticators(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_auth_identifier_per_tenant ON auth_authenticators(tenant_id, type, identifier) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_magic_link_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,                  -- sha256(code)
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_link_customer_active ON auth_magic_link_tokens(customer_id, consumed_at, expires_at);

CREATE TABLE IF NOT EXISTS auth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,      -- 'S256'
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT,
  scope TEXT NOT NULL,
  parent_id TEXT,                            -- für Rotation-Chain
  family_id TEXT NOT NULL,                   -- gleicher Wert für alle in einer Rotations-Linie
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_customer ON auth_refresh_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON auth_refresh_tokens(family_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0006_customer_auth', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
