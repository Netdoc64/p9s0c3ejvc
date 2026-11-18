-- M06 — Pricing Engine

CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_lists_tenant ON price_lists(tenant_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS price_list_items (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id),
  sku_id TEXT NOT NULL REFERENCES products(id),
  unit_price_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pli_list_sku ON price_list_items(price_list_id, sku_id);

CREATE TABLE IF NOT EXISTS qty_breaks (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id),
  sku_id TEXT,                                 -- NULL = gilt für alle SKUs der Liste
  min_qty INTEGER NOT NULL,
  unit_price_cents INTEGER,                    -- absoluter Preis
  pct_off REAL,                                -- ODER prozentualer Rabatt
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qty_breaks_lookup ON qty_breaks(price_list_id, sku_id, min_qty);

CREATE TABLE IF NOT EXISTS customer_special_prices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  sku_id TEXT NOT NULL REFERENCES products(id),
  unit_price_cents INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_csp_lookup ON customer_special_prices(customer_id, sku_id, valid_from);

CREATE TABLE IF NOT EXISTS customer_price_list_assignments (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  price_list_id TEXT NOT NULL REFERENCES price_lists(id),
  assigned_at TEXT NOT NULL
);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0008_pricing', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
