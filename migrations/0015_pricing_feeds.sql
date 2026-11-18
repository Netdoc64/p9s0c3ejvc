-- M20 — Pricing Feeds

CREATE TABLE IF NOT EXISTS tenant_pricing_feeds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  adapter TEXT NOT NULL,              -- 'aalsmeer' | 'rbc' | 'csv-generic'
  url TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT '0 5 * * *',
  drift_threshold_pct REAL NOT NULL DEFAULT 50.0,
  drift_skus_pct REAL NOT NULL DEFAULT 5.0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feeds_tenant ON tenant_pricing_feeds(tenant_id) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS feed_runs (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES tenant_pricing_feeds(id),
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'running'|'success'|'failed'|'blocked_drift'
  rows_imported INTEGER,
  rows_skipped INTEGER,
  drift_pct REAL,
  drift_blocked INTEGER NOT NULL DEFAULT 0,
  new_price_list_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_runs_lookup ON feed_runs(feed_id, started_at);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0015_pricing_feeds', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
