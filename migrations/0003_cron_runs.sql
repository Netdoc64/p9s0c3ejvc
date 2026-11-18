-- M17 — Cron Jobs Audit
CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,            -- running | success | failed
  duration_ms INTEGER,
  error_code TEXT,
  error_detail TEXT,
  trigger TEXT NOT NULL DEFAULT 'cron'  -- cron | manual | queue
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id, started_at);

CREATE TABLE IF NOT EXISTS cron_job_state (
  job_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_success_at TEXT
);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0003_cron_runs', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
