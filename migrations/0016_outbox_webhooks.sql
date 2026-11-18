-- M12 — Outbox + Webhooks

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  topic TEXT NOT NULL,                       -- e.g. 'order.confirmed.v1'
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,                     -- JSON
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | retrying | delivered | dead_letter | partial
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retry_at TEXT,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_topic ON outbox_events(tenant_id, topic);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  url TEXT NOT NULL,
  topic_filter TEXT NOT NULL DEFAULT '*',    -- exact topic or '*'
  signing_secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_subscriptions(tenant_id, active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES outbox_events(id),
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  status TEXT NOT NULL,                      -- delivered | failed | retrying
  attempt INTEGER NOT NULL,
  response_status INTEGER,
  latency_ms INTEGER,
  error_detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_event ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscription ON webhook_deliveries(subscription_id, created_at);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0016_outbox_webhooks', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
