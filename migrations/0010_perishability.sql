-- M21 — Perishability + FEFO (v1: D1-Batch-Tracking, DO bleibt Single-Counter)

CREATE TABLE IF NOT EXISTS stock_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  warehouse_id TEXT NOT NULL,
  sku_id TEXT NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  mhd TEXT,                                    -- ISO-Date, NULL = unbegrenzt haltbar
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',       -- 'active'|'consumed'|'expired'|'shrunk'
  notes TEXT,
  created_at TEXT NOT NULL,
  expired_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_batches_lookup ON stock_batches(tenant_id, warehouse_id, sku_id, mhd);
CREATE INDEX IF NOT EXISTS idx_batches_active ON stock_batches(tenant_id, sku_id) WHERE status = 'active';

ALTER TABLE tenants ADD COLUMN min_shelf_life_days INTEGER NOT NULL DEFAULT 3;

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0010_perishability', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
