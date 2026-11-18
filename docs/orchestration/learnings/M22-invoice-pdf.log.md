# M22 — Learnings

### What happened
`invoices` + `invoice_number_seq` Tabellen, `services/invoice-pdf.ts` (Plain-Text → minimaler PDF-1.4-Wrapper, ohne pdf-lib-WASM-Footprint), `services/invoice.ts` mit lückenloser Rechnungs-Nummerierung, R2-Storage, GET `/v1/invoices/:id`. Orchestrator-Handler `generate_invoice` ruft echten Service.

### Decisions
1. **Eigener Mini-PDF-Renderer** statt `pdf-lib` — Bundle-Size + WASM-Boot in Workers reduziert. Plan-Revision-Kandidat: pdf-lib für CI-Drucksachen-Optik (Logos, Tabellen).
2. **Rechnungs-Nummerierung über `invoice_number_seq`-Tabelle** mit single-row-update. Plan-Revision-Kandidat: Single-DO pro Tenant (Spec-Empfehlung) für strikte Lückenlosigkeit unter Concurrent-Confirm.
3. **Idempotenz**: 1 Invoice pro `order_id`. Doppel-Confirm → existierende Invoice zurück.
4. **Country-Specific Hinweise** automatisch: reverse_charge_eu Hinweis, export-Hinweis. Erweiterbar für CH/UK.
5. **GET /:id streams direkt aus R2** als 200 mit Content-Type=application/pdf — Signed-URL kommt als Plan-Revision (M22-Spec sagt 7d/90d-TTL, das setzt CF-Signed-URL voraus).

## 2026-11-17 — erste echte Rechnung (Staging)

### What happened
Die erste auf Staging erzeugte Rechnung (INV-2026-000001) war formal unvollständig: ohne Anschrift und USt-IdNr. des Verkäufers (bei Reverse-Charge Pflicht, Art. 226 MwStSysRL), ohne Anschrift des Empfängers, ohne Leistungsdatum, mit SKU-ID statt Bezeichnung und Beträgen als `0.80 EUR`. Der Generator konnte Verkäuferdaten drucken — `tenants` hatte aber keine Spalten dafür, und der Dienst reichte nichts durch.

### Decisions
1. **Migration 0021**: `tenants.vat_id`, `tenants.address` (JSON). `bootstrap-tenant` nimmt `--vat-id` und `--address`.
2. **Fehlen sie, wird KEINE Rechnung ausgestellt** (`GH-PDF-002`), geprüft vor der Nummernvergabe. Eine fehlerhafte Rechnung mit lückenloser Nummer lässt sich nicht still zurückholen.
3. Empfängeranschrift aus `customers.addresses.billing`, Bezeichnung aus `products.name` (mandantengetrennt), „Leistungsdatum: entspricht Rechnungsdatum“ solange das Order-Dokument kein Lieferdatum führt (`service_date` ist vorbereitet).
4. Beträge deutsch (`1.234,50 €`) — die Rechnung ist deutsch beschriftet. `tests/services/invoice-pdf.spec.ts`.
