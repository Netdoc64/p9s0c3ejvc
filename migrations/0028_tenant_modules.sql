-- Module je Tenant (Lieferanten-Anbindungen u. a.). Ein Tenant schaltet ein
-- Modul selbst ein und pflegt seine Zugänge; was er überhaupt nutzen darf
-- (`available`), legt der Betreiber fest. Geheime Felder liegen getrennt und
-- nur verschlüsselt (AES-GCM, Schlüssel abgeleitet aus dem Worker-Secret
-- MODULE_KEK); die API gibt sie nie heraus.

CREATE TABLE tenant_modules (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  module_id TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('ok', 'error', 'unchecked')),
  last_checked_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, module_id)
);

CREATE TABLE tenant_module_credentials (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  module_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL DEFAULT 1,
  salt TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, module_id)
);
