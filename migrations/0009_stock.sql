-- M08 — Stock + Warehouses + Movements

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_warehouses_tenant ON warehouses(tenant_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  type TEXT NOT NULL,                       -- 'receive'|'reserve'|'commit'|'release'|'auto_release'|'adjust'|'shrink'
  qty_delta INTEGER NOT NULL,               -- positive = added, negative = removed
  reservation_id TEXT,
  reason TEXT,
  actor_id TEXT,                            -- api_key_id, customer_id, system
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_lookup ON stock_movements(tenant_id, warehouse_id, sku_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reservation ON stock_movements(reservation_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0009_stock', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
