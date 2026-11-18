-- M23 — Push Notifications: Device Registry

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  platform TEXT NOT NULL,                  -- 'ios' | 'android' | 'web'
  push_token TEXT NOT NULL,
  app_version TEXT,
  language TEXT,
  timezone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_token ON devices(push_token) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices(customer_id, active);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0017_devices', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
