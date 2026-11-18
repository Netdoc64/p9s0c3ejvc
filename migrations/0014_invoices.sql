-- M22 — Invoices

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  invoice_number TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  country TEXT NOT NULL,
  pdf_r2_key TEXT,
  pdf_hash TEXT,
  bytes INTEGER,
  generated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_number ON invoices(tenant_id, invoice_number);

CREATE TABLE IF NOT EXISTS invoice_number_seq (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  next_number INTEGER NOT NULL DEFAULT 1,
  prefix TEXT NOT NULL DEFAULT 'INV',
  updated_at TEXT NOT NULL
);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0014_invoices', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
