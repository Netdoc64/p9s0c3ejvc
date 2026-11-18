-- M05 — Products / SKUs

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku_code TEXT NOT NULL,
  parent_sku_id TEXT,                     -- gruppiert Varianten
  name TEXT NOT NULL,
  description TEXT,
  tax_class TEXT NOT NULL DEFAULT 'standard',  -- 'standard'|'reduced'|'zero'
  is_perishable INTEGER NOT NULL DEFAULT 0,
  default_shelf_life_days INTEGER,
  min_order_qty INTEGER NOT NULL DEFAULT 1,
  packaging_units TEXT NOT NULL DEFAULT '[]', -- JSON [{name, contains, unit_of_inner}]
  attributes TEXT NOT NULL DEFAULT '{}',  -- JSON (variety, length, color, ...)
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_tenant_sku ON products(tenant_id, sku_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_parent ON products(parent_sku_id) WHERE parent_sku_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku_id TEXT NOT NULL REFERENCES products(id),
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_images_sku ON product_images(sku_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0005_products', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
