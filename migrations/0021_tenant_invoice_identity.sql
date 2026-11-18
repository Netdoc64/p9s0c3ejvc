-- Pflichtangaben des Verkäufers auf der Rechnung (Art. 226 MwStSysRL, § 14 UStG):
-- vollständige Anschrift und USt-IdNr. Bis 2026-11-17 hatte `tenants` dafür keine
-- Spalten, und jede erzeugte Rechnung war formal unvollständig. Aufgefallen an
-- der ersten echten Rechnung auf Staging.
--
-- Nullable: bestehende Tenants bekommen die Werte per Update. Solange sie fehlen,
-- stellt der Rechnungsdienst KEINE Rechnung aus (GH-PDF-002), statt eine
-- fehlerhafte zu erzeugen.
ALTER TABLE tenants ADD COLUMN vat_id TEXT;
-- JSON: {"line1": "...", "postal_code": "...", "city": "...", "country": "NL"}
ALTER TABLE tenants ADD COLUMN address TEXT;
