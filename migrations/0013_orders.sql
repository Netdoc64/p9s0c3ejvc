-- M09 — Orders + Order Lines + Order Document Storage

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  doc_type TEXT NOT NULL DEFAULT 'order',
  schema_version TEXT NOT NULL DEFAULT 'order-document/1.0',
  state_current TEXT NOT NULL,                  -- draft | resolving | awaiting_confirmation | confirmed | shipped | invoiced | paid | cancelled | on_hold
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  customer_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON
  source TEXT NOT NULL DEFAULT '{}',            -- JSON
  actor TEXT NOT NULL DEFAULT '{}',             -- JSON
  totals TEXT NOT NULL DEFAULT '{}',            -- JSON
  plan TEXT NOT NULL DEFAULT '{}',              -- JSON next_steps[]+executed_steps[]
  audit TEXT NOT NULL DEFAULT '{}',             -- JSON ai_decisions[]
  gates_log TEXT NOT NULL DEFAULT '{}',         -- JSON
  external_refs TEXT NOT NULL DEFAULT '{}',     -- JSON
  issues TEXT NOT NULL DEFAULT '{}',            -- JSON {blocking[], warnings[]}
  state_history TEXT NOT NULL DEFAULT '[]',     -- JSON [{from,to,by_step_id,ts}]
  parent_order_id TEXT,                         -- für Sub-Documents (M21+: credit_note, shipment, return)
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(tenant_id, state_current);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER,
  tax_scheme TEXT,
  tax_rate_pct REAL,
  tax_rule_id TEXT,
  line_total_cents INTEGER,
  reservation_id TEXT,
  resolution TEXT NOT NULL DEFAULT '{}',        -- JSON pricing/tax breakdown
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_lines_no ON order_lines(order_id, line_no);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0013_orders', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
