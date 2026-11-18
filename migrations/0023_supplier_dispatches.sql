CREATE TABLE supplier_dispatches (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'unknown', 'submitted', 'rejected')),
  remote_id TEXT,
  PRIMARY KEY (tenant_id, provider, account, id)
);
