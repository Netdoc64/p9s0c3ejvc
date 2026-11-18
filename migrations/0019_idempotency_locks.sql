-- Audit-Fix #I-001: Idempotency-In-Flight-Race über D1 absichern.
-- KV bleibt für gecachten Response-Body (24h), D1-Tabelle ist der Lock.
--
-- Erster Request: INSERT (uniq_violation → lost), Handler läuft, schreibt body in KV.
-- Zweiter parallele Request: INSERT-Conflict → busy-wait kurz auf KV-Hit, sonst 409.

CREATE TABLE IF NOT EXISTS idempotency_locks (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_flight', -- 'in_flight' | 'completed'
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
  ON idempotency_locks(created_at);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0019_idempotency_locks', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
