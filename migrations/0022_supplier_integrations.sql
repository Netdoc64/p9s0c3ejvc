CREATE TABLE supplier_sync_state (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  PRIMARY KEY (tenant_id, provider, connection, stream)
);

CREATE TABLE supplier_records (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  stream TEXT NOT NULL,
  external_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, connection, stream, external_id)
);

CREATE TABLE supplier_purchase_orders (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitting', 'unknown', 'submitted', 'rejected')),
  provider_status TEXT,
  provider_sequence INTEGER,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);


CREATE INDEX supplier_purchase_pending ON supplier_purchase_orders
  (tenant_id, provider, connection, last_checked_at, created_at)
  WHERE status IN ('submitting', 'unknown', 'submitted')
    AND (provider_status IS NULL OR provider_status IN ('PENDING', 'ACCEPTED'));
