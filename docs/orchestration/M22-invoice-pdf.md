---
module_id: M22_invoice_pdf
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P3_orders
---

# M22 — Invoice PDF + Signed URLs

## Goal

Rechnungs-PDFs werden bei Order-Confirm generiert, in R2 abgelegt und über
signierte, ablaufende URLs an Tenant + Customer ausgeliefert — mit allen
Pflichtangaben pro Land.

## Non-Goals

- Kein eigener Layout-Editor (Tenants akzeptieren ein generisches Template
  mit Logo + Farben; Custom-Templates → Plan-Revision)
- Keine ZUGFeRD/Factur-X-Embedded-Datasets v1 (deferred — XML in PDF einbetten ist Aufwand)

## Success Criteria

- Auf `order.confirmed` wird PDF generiert in <10s p99
- PDF erfüllt Pflichtangaben pro Tenant-Country (DE: §14 UStG, NL: BTW-Wet, CH: MWSTG)
- Signed URL gültig 7d für Customer, 90d für Tenant
- PDF in R2 unter `r2://<tenant_id>/invoices/<year>/<invoice_id>.pdf`,
  versioniert (immutable nach Erstellung)
- Idempotent: zweimal generieren erzeugt **eine** Datei, kein Duplikat

## Execution Intent (Vibe)

- **PDF-Generation in CF-Worker** via wasm-PDF-Lib (`pdf-lib`-Port oder ähnlich) —
  KEIN Headless-Chromium (zu schwer).
- **Template als Code**, nicht als WYSIWYG-File. Branding via Tenant-Settings
  (Logo-R2-URL, Akzentfarbe, Footer-Text).
- **Pflichtangaben pro Land in Tabelle hinterlegt** (`invoice_country_requirements`),
  Generator validiert vor Ausgabe.
- **Idempotency-Key:** `invoice_id` selbst — wenn Datei in R2 existiert, kein Re-Generate.

## Inputs Required

- M11 (Orders-API mit `order.confirmed`-Hook)
- M07 (Tax-Engine — für `tax_lines`-Detail im PDF)
- Tenant-Setting für Logo + Branding
- Country-Pflichtangaben-Tabelle

## Deliverables

```
src/services/invoice-pdf/
  generator.ts                         pdf-lib-basiert, Layout-Code
  template.standard.ts                 v1-Template
  country-requirements.ts              DE, NL, CH initial
  branding.ts                          Tenant-Settings-Mapper
src/cron/jobs/.. (none)
src/routes/invoices.ts                 GET /invoices/:id (signed URL)
src/orchestrator/handlers/generate-invoice.ts (Step für M10)
migrations/00XX_invoices.sql           invoices, invoice_documents
tests/services/invoice-pdf/...
```

## Pflichtangaben (DE-§14-UStG-Beispiel)

- Vollständiger Name + Anschrift Tenant + Customer
- Steuernummer ODER USt-ID-Nr Tenant
- Ausstellungsdatum
- Fortlaufende Rechnungsnummer
- Menge + Art der Leistung
- Lieferdatum / Leistungszeitraum
- Entgelt + Steuersatz aufgeschlüsselt
- Hinweis bei Reverse-Charge: „Steuerschuldnerschaft des Leistungsempfängers"

Validator schlägt fehl, wenn Pflichtfeld leer.

## Happy Path

1. Order-Orchestrator (M10) erreicht Step `step_invoice` nach `confirmed`
2. Handler ruft `generateInvoicePdf(order_doc)` auf
3. Generator validiert Pflichtangaben (Country-Requirements) → fail-fast wenn fehlt
4. PDF wird gerendert, in R2 geschrieben (immutable)
5. `invoices`-Row mit `pdf_r2_key` + `invoice_number` (lückenlos pro Tenant pro Jahr — siehe Risk R5)
6. Order-Doc wird mit `external_refs.invoice_id` aktualisiert
7. Signed URL wird zurück an Customer-Notification + Webhook-Event geschickt

## Error Paths

| Symptom                                  | Code            | Recovery |
|------------------------------------------|-----------------|----------|
| Pflichtangabe fehlt (z.B. VAT-ID Tenant) | `GH-PDF-001`    | 500-internal, Alert; Order bleibt im State `confirmed` ohne Invoice |
| R2 unerreichbar                          | `GH-INFRA-001`  | Step retry, Order bleibt in `pending_invoice` |
| Rechnungsnummer-Vergabe-Konflikt         | `GH-PDF-001`    | Single-DO pro Tenant für Nummern (Risk R5) |
| PDF-Lib OOM bei sehr grossen Orders      | `GH-PDF-001`    | Fallback: Streaming-Generation oder Order splitten — Plan-Revision |

## Fallbacks

- Wenn Auto-Generation scheitert: Fallback auf Hintergrund-Queue (Retry) +
  Tenant-Operator-Notification. Order ist bestätigt, PDF kommt nach.
- Wenn dauerhaft nicht generierbar (Datenfehler): manuelle Korrektur via Operator-API.

## Backwards-Compat Implications

- Rechnungsnummern lückenlos und permanent — never-rewrite
- PDF-Templates können evolvieren, aber alte PDFs bleiben in R2 unverändert
  (immutable storage)
- Country-Requirements additiv erweiterbar (neue Länder), niemals retroaktiv
  Pflichtfelder ändern

## Open Questions

- [x] ~~PDF-Engine?~~ → **`pdf-lib` via wasm im Worker** (2026-04-28). Reason:
  Edge-tauglich, keine Browser-Abhängigkeit, akzeptable Layout-Qualität für
  Standardrechnungen.
- [x] ~~ZUGFeRD/Factur-X v1?~~ → **Nein, deferred** (2026-04-28). Reason: B2B-Pilot
  akzeptiert PDF; XML-Embedding ist eigenes grösseres Modul.
- [x] ~~Signed-URL-TTL?~~ → **7d Customer / 90d Tenant** (2026-04-28).

## Observability

- `invoice.pdf.generation_duration_ms`
- `invoice.pdf.failed`-Counter
- `invoice.signed_url.served`-Counter (für Cache-Sizing)

## Test Strategy

- Snapshot-Test pro Country: Order-Doc-Fixture → PDF mit allen Pflichtangaben
- Pflichtangaben-Validator: fehlende VAT-ID → fail-fast
- Idempotenz: zweimal generieren → eine R2-Datei, kein Doppelnummer
- Rechnungsnummer-Lückenlosigkeit unter Concurrent-Confirm

## Learnings

→ `learnings/M22-invoice-pdf.log.md`

## Plan Revisions Originating Here

(initial leer)
