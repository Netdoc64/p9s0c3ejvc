-- M01 Skeleton — Initial Migration
-- Reine Metadata-Tabelle. Domänen-Tabellen kommen in M02+.

CREATE TABLE IF NOT EXISTS _migrations_meta (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  schema_version TEXT NOT NULL
);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0001_init', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
