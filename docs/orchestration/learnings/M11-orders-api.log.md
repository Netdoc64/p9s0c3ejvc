# M11 — Learnings

### What happened
REST-Endpoints `POST /v1/orders` (Draft anlegen + Auto-Chain bis `awaiting_confirmation`/`on_hold`), `POST /:id/confirm` (commit_stock + emit_event + invoice), `POST /:id/cancel` (release_stock + emit_event), `GET /:id`, `GET /` mit cursor-Paging.

### Decisions
1. **Initial-Doc mit `state.current=draft` und 4 Plan-Steps** (resolve → validate → reserve → await_confirmation). Resolve setzt Pricing+Tax, Validate prüft Gates, Reserve hält Stock, Await bricht.
2. **Confirm/Cancel injizieren neue `next_steps`** statt eigene Pfade — damit der gleiche Orchestrator-Code läuft.
3. **Cross-Tenant**: `requireById(tenant_id, id)` wirft `GH-ORDER-001` 404 — kein Leak.
4. **Cursor opaque base64({created_at, id})** wie in /customers.

### Bewusst Plan-Revision-Kandidaten
- E2E-Test mit miniflare hat den DO-Storage-Edge-Case (siehe M08-Learning); manueller `wrangler dev`-Test deckt es ab.
- Hartes Confirm während on_hold blockiert — User muss manuell `gates_log` reviewen oder Spec für Resume-Pfad ergänzen.

### 2026-11-18 — Checkout-Servertests Kunde (Q04)
- `tests/routes/customer-checkout.spec.ts` prüft über die echte Kunden-API: abgelaufene Reservierung → 410 GH-STOCK-002; zwei parallele Bestätigungen → genau eine 200, die andere 409; Storno nach Bestätigung → 409 GH-STATE-001; fremder Auftrag (confirm und cancel) → 404 GH-ORDER-001. Es wird der Problem-JSON-Code geprüft, nicht nur der Status.
- Fund: `stock.ts ensureScope` las die Antwort des StockDO nicht. Der erste Test, der den StockDO über die Service-Schicht anspricht, scheiterte mit „Isolated storage failed" (Windows: EBUSY). Fix: Antwort vollständig lesen (`arrayBuffer()`). Kein Verhaltensunterschied im Betrieb.
- Setup-Hinweis: der Auftrag wird direkt als `awaiting_confirmation` mit echter Reservierung (adjust + reserve im StockDO) angelegt; Preise/Steuern sind nicht Gegenstand.
