-- M16 — Secrets Rotation (Doppel-Reader)

ALTER TABLE api_keys ADD COLUMN hmac_secret_previous TEXT;
ALTER TABLE api_keys ADD COLUMN hmac_secret_previous_until TEXT;
ALTER TABLE api_keys ADD COLUMN key_hash_previous TEXT;
ALTER TABLE api_keys ADD COLUMN key_hash_previous_until TEXT;

ALTER TABLE tenants ADD COLUMN customer_jwt_secret_previous TEXT;
ALTER TABLE tenants ADD COLUMN customer_jwt_secret_previous_until TEXT;

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0011_secrets_rotation', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
