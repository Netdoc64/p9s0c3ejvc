-- Audit-Fix #Q-004: tenant_id-Spalte auf customer_price_list_assignments für Defense-in-Depth.
-- Pre-production: kein Datenmigration-Pfad nötig. Tabelle ist (in v1) leer.

-- SQLite kann Spalte nicht trivial mit FK + NOT NULL + DEFAULT addieren wenn Daten existieren.
-- Wir nutzen den Pattern: rename + recreate.

ALTER TABLE customer_price_list_assignments RENAME TO _cpla_old;

CREATE TABLE customer_price_list_assignments (
  customer_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  price_list_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, customer_id)
);

-- Falls _cpla_old Daten enthält, müssten sie hier mit tenant_id-Lookup über customers
-- repopuliert werden. Pre-production: leer, daher skip.
DROP TABLE _cpla_old;

CREATE INDEX IF NOT EXISTS idx_cpla_customer
  ON customer_price_list_assignments(tenant_id, customer_id);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0020_cpla_tenant_column', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;
