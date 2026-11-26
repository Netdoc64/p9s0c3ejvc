-- Einkaufsanforderungen aus Kundenbestellungen (Quellenmix Teil 2).
--
-- Eine bestätigte Kundenbestellung, deren Position nicht aus eigenem Bestand,
-- sondern aus einer Lieferanten-Quelle kommt, erzeugt genau eine Anforderung
-- je Position. Gesendet wird sie erst durch einen Inhaber (Geld fließt,
-- nicht zurückholbar) — bei Floriday als Einkaufsbestellung, bei
-- Lieferanten-Dateien über die Bestellliste.

CREATE TABLE supplier_purchase_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  sku_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  source_qty INTEGER NOT NULL CHECK (source_qty > 0),
  cost_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'sent', 'cancelled', 'cancel_requested', 'failed')),
  supplier_order_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, order_id, line_no)
);
CREATE INDEX supplier_purchase_requests_open ON supplier_purchase_requests (tenant_id, status, provider, connection);
