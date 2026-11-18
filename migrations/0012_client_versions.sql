-- M24 — Client Versioning

CREATE TABLE IF NOT EXISTS client_min_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  platform TEXT NOT NULL,                     -- 'ios' | 'android' | 'web'
  min_version TEXT NOT NULL,                  -- SemVer
  hard_cutoff_at TEXT,                        -- nach diesem Datum 426
  soft_sunset_at TEXT,                        -- 30d vorher
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, platform)
);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0012_client_versions', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
