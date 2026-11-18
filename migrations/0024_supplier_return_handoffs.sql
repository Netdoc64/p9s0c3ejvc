-- Durable acknowledgement ledger on the receiving supplier edge.
CREATE TABLE supplier_return_handoffs (
  handoff_id TEXT PRIMARY KEY,
  supplier_tenant_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE INDEX idx_supplier_return_handoffs_tenant
  ON supplier_return_handoffs(supplier_tenant_id, handoff_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0024_supplier_return_handoffs', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
