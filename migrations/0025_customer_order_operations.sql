CREATE TABLE customer_order_operations (
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('draft', 'confirm', 'cancel')),
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, customer_id, operation_id),
  UNIQUE (tenant_id, customer_id, idempotency_key)
);

CREATE INDEX customer_order_operations_order ON customer_order_operations (tenant_id, customer_id, order_id);

CREATE UNIQUE INDEX customer_order_operations_active_order
ON customer_order_operations (tenant_id, customer_id, order_id)
WHERE response_json IS NULL;

CREATE UNIQUE INDEX customer_order_operations_active_draft
ON customer_order_operations (tenant_id, customer_id)
WHERE response_json IS NULL AND kind = 'draft';
