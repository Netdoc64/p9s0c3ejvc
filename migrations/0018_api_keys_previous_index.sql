-- M16 Plan-Revision: dedicated Index auf key_hash_previous für O(log n)-Lookup
-- Vorher: Doppel-Reader machte Full-Table-Scan via OR-Klausel.

CREATE INDEX IF NOT EXISTS idx_api_keys_previous_hash
  ON api_keys(key_hash_previous)
  WHERE key_hash_previous IS NOT NULL AND revoked_at IS NULL;

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0018_api_keys_previous_index', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
