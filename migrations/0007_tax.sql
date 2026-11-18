-- M07 — Tax Engine

CREATE TABLE IF NOT EXISTS tax_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,                       -- NULL = global default
  rule_id TEXT NOT NULL,                -- semantischer Identifier (permanent)
  description TEXT NOT NULL,
  -- Match-Felder; NULL = Wildcard
  match_tenant_country TEXT,
  match_customer_country TEXT,
  match_b2b_b2c TEXT,
  match_vat_status TEXT,
  match_sku_tax_class TEXT,
  match_cross_border INTEGER,           -- NULL=any, 1=tenant!=customer, 0=tenant==customer
  -- Output
  scheme TEXT NOT NULL,
  rate_pct REAL NOT NULL,
  decision_reason_template TEXT NOT NULL,
  -- Tiebreaker: niedriger = höhere Priorität (Default 100)
  priority INTEGER NOT NULL DEFAULT 100,
  -- Versioning
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_rules_lookup ON tax_rules(tenant_id, valid_from, valid_to);

INSERT INTO _migrations_meta (id, applied_at, schema_version)
VALUES ('0007_tax', datetime('now'), 'build-plan/1.0')
ON CONFLICT (id) DO NOTHING;

-- Globales EU/CH-Standardregelset (Stand 2026)
-- priority: niedriger = höher; tax_class=zero (10) > export (20) > reverse_charge (50) > country-standard (100)
INSERT OR IGNORE INTO tax_rules (id, tenant_id, rule_id, description, match_tenant_country, match_customer_country, match_b2b_b2c, match_vat_status, match_sku_tax_class, match_cross_border, scheme, rate_pct, decision_reason_template, priority, valid_from, valid_to, created_at) VALUES
  ('tax_rule_zero',       NULL, 'sku_zero',             'SKU mit tax_class=zero',  NULL, NULL, NULL, NULL, 'zero', NULL, 'zero', 0.0, 'SKU steuerfrei (tax_class=zero)', 10, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_ch_export',  NULL, 'ch_export',            'Export nach CH 0%',       NULL, 'CH', NULL, NULL, NULL, 1, 'export', 0.0, 'Export Drittland CH 0%', 20, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_eu_b2b_rc',  NULL, 'eu_b2b_reverse_charge','EU B2B Reverse Charge (cross-border, valid VAT)', NULL, NULL, 'b2b', 'valid', NULL, 1, 'reverse_charge_eu', 0.0, 'EU-B2B Reverse-Charge gem. §13b UStG / Art. 196 MwStSysRL', 50, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_de_std',     NULL, 'de_standard',          'DE Standard 19% B2B/B2C', 'DE', 'DE', NULL, NULL, 'standard', 0, 'standard', 19.0, '§12 UStG Standard 19%', 100, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_de_red',     NULL, 'de_reduced',           'DE Reduced 7%',           'DE', 'DE', NULL, NULL, 'reduced', 0, 'reduced', 7.0,  '§12(2) UStG Reduced 7%', 100, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_nl_std',     NULL, 'nl_standard',          'NL Standard 21% B2B/B2C', 'NL', 'NL', NULL, NULL, 'standard', 0, 'standard', 21.0, 'NL BTW 21%', 100, '2024-01-01T00:00:00Z', NULL, datetime('now')),
  ('tax_rule_nl_red',     NULL, 'nl_reduced',           'NL Reduced 9%',           'NL', 'NL', NULL, NULL, 'reduced', 0, 'reduced', 9.0,  'NL BTW 9%', 100, '2024-01-01T00:00:00Z', NULL, datetime('now'));
