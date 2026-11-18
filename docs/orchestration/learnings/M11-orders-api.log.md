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
