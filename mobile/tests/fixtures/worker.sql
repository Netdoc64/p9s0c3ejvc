INSERT INTO tenants (id,slug,name,country,currency,customer_jwt_secret,status,vat_id,address,created_at,updated_at)
VALUES ('t_mobile_local','mobile-test','Pilot Blumenhandel','NL','EUR','local-browser-test-fixture-not-a-deployed-key','active','NL000000000B01','{"line1":"Musterstraat 1","city":"Aalsmeer","postal_code":"1000 AA","country":"NL"}','2026-01-01','2026-01-01');
INSERT INTO customers (id,tenant_id,name,email,country,b2b_b2c,vat_status,addresses,created_at,updated_at)
VALUES ('cust_mobile_a','t_mobile_local','Floraly Test','floraly@example.test','NL','b2b','not_required','{"billing":{"line1":"Musterstraat 2","city":"Aalsmeer","postal_code":"1000 AA","country":"NL"}}','2026-01-01','2026-01-01'),
       ('cust_mobile_b','t_mobile_local','Blume Test','blume@example.test','NL','b2b','not_required','{"billing":{"line1":"Musterstraat 3","city":"Aalsmeer","postal_code":"1000 AA","country":"NL"}}','2026-01-01','2026-01-01');
INSERT INTO warehouses (id,tenant_id,name,country,is_default,created_at)
VALUES ('wh_mobile_local','t_mobile_local','Testlager','NL',1,'2026-01-01');
INSERT INTO products (id,tenant_id,sku_code,name,packaging_units,created_at,updated_at)
VALUES ('sku_mobile_rose','t_mobile_local','RO-MOBILE-60','Rose Mobile 60 cm','[{"name":"carton","contains":50,"unit_of_inner":"stem"}]','2026-01-01','2026-01-01');
INSERT INTO price_lists (id,tenant_id,name,currency,is_default,valid_from,created_at)
VALUES ('pl_mobile_local','t_mobile_local','Pilottest','EUR',1,'2026-01-01','2026-01-01');
INSERT INTO price_list_items (id,price_list_id,sku_id,unit_price_cents,created_at)
VALUES ('pli_mobile_local','pl_mobile_local','sku_mobile_rose',950,'2026-01-01');
