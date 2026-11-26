-- Quellenmix: Verkaufsartikel aus Lieferanten-Angeboten.
--
-- product_sources      welche Angebote einen Verkaufsartikel beliefern können
-- sourcing_rules       wie gewählt und aufgeschlagen wird (je Tenant)
-- product_sourcing_state  die zuletzt gewählte Quelle je Artikel samt Preis
-- price_list_items.managed_by  'sourcing' = Preis kommt aus dem Quellenmix und
--                      wird bei jeder Neuberechnung überschrieben; NULL = von
--                      Hand gepflegt und wird NIE angefasst.

CREATE TABLE sourcing_rules (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  strategy TEXT NOT NULL DEFAULT 'cheapest' CHECK (strategy IN ('cheapest', 'priority', 'fastest')),
  priority TEXT NOT NULL DEFAULT '[]',
  markup_pct REAL NOT NULL DEFAULT 30,
  min_margin_cents INTEGER NOT NULL DEFAULT 0,
  round_to_cents INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE product_sources (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  pack_factor INTEGER NOT NULL DEFAULT 1 CHECK (pack_factor >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sku_id, provider, connection, source_ref)
);
CREATE INDEX product_sources_sku ON product_sources (tenant_id, sku_id);

CREATE TABLE product_sourcing_state (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku_id TEXT NOT NULL,
  provider TEXT,
  connection TEXT,
  source_ref TEXT,
  cost_cents INTEGER,
  price_cents INTEGER,
  available_units INTEGER NOT NULL DEFAULT 0,
  delivery_from TEXT,
  expires_at TEXT,
  reason TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sku_id)
);

ALTER TABLE price_list_items ADD COLUMN managed_by TEXT;
