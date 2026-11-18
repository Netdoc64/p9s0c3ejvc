---
module_id: M05_products
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M05 — Products / SKUs + Catalog Import

## Goal

Produkt-Stammdaten mit Varianten, Verpackungseinheiten, Bildern und einem
Streaming-CSV-Import, der zigtausend Zeilen ohne Memory-Spike verarbeitet.

## Non-Goals

- Keine Product-Information-Management-Features (Übersetzungen, Lokalisierung
  über das Hinaus, was im Pilot nötig ist)
- Keine Kategorien-Bäume in v1 (flach reicht für den Pilot)

## Success Criteria

Wie Build-Plan `M05_products.acceptance[]`. Zusätzlich:

- CSV-Import via `Web Streams API`, kein In-Memory-Buffer >2 MB
- Bilder unter `r2://<tenant_id>/products/<sku_id>/<hash>.jpg`
- Suche tolerant gegenüber Tippfehlern (Pilot-Niveau)

## Execution Intent (Vibe)

- Stammdaten möglichst frei von Computed-Logik. Berechnungen (Preis, Steuer,
  Bestand) leben in eigenen Engines, nicht im Product.
- Stream-First für Import. Validierung pro Zeile, Ergebnis-Report mit
  `imported_ok`, `imported_failed[]`.

## Inputs Required

- M03 fertig
- Antworten auf Open Questions (siehe unten)

## Deliverables

```
migrations/00XX_products.sql           products, product_variants, packaging_units
src/repos/products.ts
src/services/catalog-import.ts         Streaming-CSV
src/routes/products.ts                 CRUD + Search + Import
src/routes/product-images.ts           R2-Upload
src/schemas/product.ts                 Zod
tests/services/catalog-import.spec.ts  inkl. 10k-Zeilen-Stress
```

## Happy Path

**Single SKU:**
1. `POST /v1/products` mit `{name, sku_code, parent_sku_id?, packaging_units[], tax_class, attributes{}}`.
2. M02-Pipeline. Zod-Parse. `INSERT products (id="sku_"+ulid(), tenant_id, ...)`.
3. 201 mit Resource.

**CSV-Import:**
4. `POST /v1/products/import` (multipart `text/csv`).
5. Stream-Body via `Web Streams API` → `TextDecoderStream` → Line-Splitter (custom Transform).
6. Erste Zeile = Header (validate gegen erwartetes Schema).
7. Pro Datenzeile: Zod-Parse → on success Push in Insert-Batch (max 100 Rows). Bei Voll → D1 `INSERT INTO products VALUES (...) ON CONFLICT DO NOTHING`-Batch. On error → Push in `imported_failed[]` mit `line_number`, `error_code`, `detail`.
8. Stream-Ende: Final-Batch flushen.
9. 200 mit `{imported_ok: n, imported_failed: [{line, code, detail}], duration_ms}`.

**Bild-Upload:**
10. `POST /v1/products/:id/images` (multipart `image/*`, max 5 MB).
11. Hash über Body. Pfad `<tenant_id>/products/<sku_id>/<hash>.<ext>`. `R2.put(path, body, {httpMetadata, customMetadata: {tenant_id, sku_id}})`.
12. `INSERT product_images (sku_id, r2_key, hash, content_type)`.
13. 201 mit `{image_id, url: "/v1/products/:id/images/:image_id"}` (Resize via CF-Image-Resizing Query-Params on read).

**Suche:**
14. `GET /v1/products/search?q=rote+rose+60`.
15. Tokenize Query → LIKE-Conditions auf `name`, `sku_code`, `attributes.varietal`. Score = Treffer-Anzahl, ORDER BY score DESC LIMIT 20.

## Error Paths

| Symptom                            | Code             | Recovery |
|------------------------------------|------------------|----------|
| SKU nicht gefunden                 | `GH-PROD-001`    | 404 |
| Upload zu gross                    | `GH-INPUT-002`   | 413 |
| CSV-Zeile invalid                  | `GH-INPUT-001`   | im Report, kein Abbruch |

## Fallbacks

- R2 nicht erreichbar bei Bild-Upload → 503 mit Retry-Hint, kein Datenverlust

## Backwards-Compat Implications

- SKU-ID-Format `sku_<ulid>` permanent
- Verpackungseinheiten-Enum (`piece`, `carton`, `pallet`, …) erweiterbar, nicht
  umbenennen

## Open Questions

- [x] ~~Bild-Resizing on-demand vs vorab?~~ → **On-Demand via CF Image Resizing**
  (2026-04-28). Reason: kleinerer Footprint, keine Pre-Job-Pipeline; Optimierung
  zu Vorab-Varianten ist Plan-Revision wenn Image-Costs Hot werden.
- [x] ~~Variante = eigene SKU oder Attribut?~~ → **Eigene SKUs mit
  `parent_sku_id`** (2026-04-28). Reason: Bei Blumen hat jede Länge/Sorte
  eigenen Bestand — nur SKU-Granularität erlaubt korrekte Stock-DOs.
  `parent_sku_id` (optional) gruppiert für UI/Suche.
- [x] ~~Tax-Class auf SKU-Ebene?~~ → **Ja**, Enum
  `tax_class: "standard" | "reduced" | "zero"`, Default `"standard"`
  (2026-04-28). Reason: minimaler Aufwand jetzt, kompletter Steuer-Engine-Input
  ohne Schema-Migration später.

## Observability

- Catalog-Import-Dauer / Zeilen pro Sekunde
- R2-Upload-Fehlerrate

## Test Strategy

- Streaming-CSV mit 10k, 100k Zeilen (Memory-Profile)
- Bild-Upload mit verschiedenen Formaten
- Suche-Tests: deutsch, englisch, mit Tippfehler

## Learnings

→ `learnings/M05-products.log.md`

## Plan Revisions Originating Here

(initial leer)
