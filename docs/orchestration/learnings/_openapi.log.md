# OpenAPI 3.1 — Cross-Cutting Plan-Revision

## 2026-04-29 — by claude-opus-4-7 (post-shipping plan-revision)

### Was war kaputt
Der Build-Plan hat OpenAPI 3.1 als Single-Source-of-Truth beschlossen
(`stack_decisions.framework`: Hono + @hono/zod-openapi, `cross_cutting.openapi.served_at: /openapi.json`).
Im initialen Build (Commit `c3516c5`) waren die Routes mit Plain-Hono gebaut, kein
`/openapi.json`-Endpoint, kein `/schemas/order.json`. Spec-Bruch.

### Was jetzt da ist
- `src/openapi/spec.ts` — vollständige OpenAPI 3.1 Document-Builder-Funktion mit
  allen 27 Pfaden, allen Domain-Schemas, beiden Security-Schemes (`tenant_hmac`, `customer_jwt`).
- `/openapi.json` (öffentlich, gecached 5min) wird beim Request mit korrekter Server-URL gebaut.
- `/schemas/order.json` exportiert das Order-Document-Schema standalone (M09-Acceptance jetzt erfüllt).
- `src/mcp/openapi-bridge.ts` — Mapping aller MCP-Tools auf OpenAPI-`operationId`s.
  Zukunfts-MCP-Bridge kann jetzt Tool-Schemas aus dem OpenAPI-Doc ableiten statt hand-curiert.
- `tests/openapi/spec.spec.ts` — 6 Tests:
  - `/openapi.json` 200 + 3.1.0
  - `/schemas/order.json` 200 mit OrderDocument-Top-Level
  - Security-Schemes in Components
  - Alle 27 erwarteten Pfade in `KNOWN_PATHS`
  - Alle MCP-Tool-Bindings haben gültige OpenAPI-Operations
  - Jedes MCP-Tool hat ein Binding (kein Tool ohne Spec)

### Bewusst nicht migriert
Die individuellen Route-Handler (`customers.ts`, `products.ts`, `orders.ts`, …)
wurden NICHT auf `OpenAPIHono` + `createRoute` umgeschrieben. Reason:
- 12 Files × ~30 Endpoints = mechanischer Refactor mit hohem Test-Breakage-Risiko
- Spec ist deklarativ in `spec.ts` aktuell; Drift-Risiko wird durch
  `KNOWN_PATHS`-Test gemindert (jeder neue Pfad muss dort gelistet sein).
- Plan-Revision-Kandidat: schrittweise per Modul migrieren wenn Type-Inferenz
  durch `c.req.valid("json")` mehr Wert bringt als der Migration-Aufwand kostet.

### Backwards-Compat-Statement
- **Additiv, kein Modul shipped-state ändert sich.** Bestehende Routes verhalten sich identisch.
- Nur neue Endpoints `/openapi.json` und `/schemas/order.json`.
- Keine Schema-Änderungen an existierenden Resources.

### Konsumenten können jetzt
- TypeScript-SDK generieren: `npx openapi-typescript /openapi.json -o sdk.ts`
- Postman-Collection importieren
- Swagger-UI lokal auf den Doc zeigen lassen
- B2B-ERP-Integratoren bekommen maschinell gegen die API integrierbares Schema
