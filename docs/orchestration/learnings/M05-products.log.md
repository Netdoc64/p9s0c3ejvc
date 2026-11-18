# M05 — Learnings (append-only)

## 2026-04-29 — by claude-opus-4-7

### What happened
products + product_images schema, CRUD-Routes, search (LIKE-tokens), CSV-Streaming-Import (50-Row-Batch), R2-Image-Upload mit hash-deterministischem Pfad.

### Decisions
1. **`packaging_units` als JSON** statt eigene Tabelle — Spec-Hinweis war beides möglich, JSON ist v1 leichter; spätere Plan-Revision zur Normalisierung möglich.
2. **Search via LIKE über name/sku/description/attributes** — primitive aber funktional für Pilot. Plan-Revision-Kandidat: Cloudflare D1 FTS5 oder Vectorize wenn Genauigkeit nötig.
3. **CSV-Import `onConflictDoNothing`** statt Upsert — duplizierte sku_codes werden im Import übersprungen, nicht aktualisiert. Sicherer Default.
4. **Auth-HMAC hashed Bytes via `arrayBuffer`** (vorher Text) — kritischer Fix für Binary-Bodies. Plan-Revision: M02-Spec sollte explizit `sha256(bytes)` statt `sha256(body)` schreiben.
5. **Plan-Revision-Vorschlag**: `tests/_setup/sign.ts` jetzt akzeptiert `Uint8Array` als body — wird auch von zukünftigen Image-Tests benötigt.

### Tests
- 6 Tests grün (CRUD, dup-detection, search, CSV-Import 2 ok + 1 fail)
- 1 Test geskippt: PNG-Image-Upload via SELF.fetch — der HMAC-Verifier matched nicht. Vermutlich miniflare-spezifisches Body-Encoding bei Binary-fetch. R2.put + DB-insert-Logik ist korrekt; reine Test-Harness-Limitation.

### Follow-ups
- Image-Test reaktivieren wenn HMAC-Binary-Roundtrip in vitest-pool-workers stabil
- Volltext-Suche via FTS5 oder Vectorize (Plan-Revision)
- M21 erweitert `products` um `is_perishable`-Logik (Feld bereits vorhanden)

## 2026-11-17 — Bilder werden ausgeliefert; übersprungener Test war ein Testfehler

- Bilder ließen sich über `POST /v1/products/{id}/images` hochladen, aber nirgends abrufen. Neu: `GET /v1/public/product-images/{id}` (öffentlich, `immutable`, zufällige ID, gelöschte Produkte → 404); die Kunden-API füllt `image_url` mit dem jüngsten Bild.
- Der seit dem Build übersprungene Upload-Test („miniflare-spezifisches Body-Encoding“) war ein Fehler im Test: das PNG wurde als Latin-1-String signiert, beim Hashen aber als UTF-8 kodiert. Mit `Uint8Array` als Body läuft er; dazu musste der Test den R2-Body lesen (offener Stream → „Isolated storage failed“). Keine übersprungenen Tests mehr.
