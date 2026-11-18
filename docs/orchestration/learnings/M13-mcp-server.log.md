# M13 — Learnings

### What happened
MCP-Endpoint `/mcp` mit JSON-RPC 2.0 (initialize, tools/list, tools/call), 8 Tools (search_products, get_price_quote, list_customers, create_order_draft, confirm_order, cancel_order, get_order, list_orders), per-Customer-Auth via Bearer-JWT (M02b).

### Decisions
1. **Two-Tool-Pattern erzwungen**: `create_order_draft` setzt State `awaiting_confirmation`; nur `confirm_order` macht commit. Versuch confirm aus anderem State → `GH-MCP-002`.
2. **Scope-Modell**: Standard-Magic-Link-Login gibt `customer_self`-Scope. Tool-Scope `read` läuft mit `customer_self`, `write` ebenfalls. Differenzierung "read-only Token" wäre Plan-Revision (eigener Scope `customer_self_readonly`).
3. **Customer-only-Sicht**: list_customers gibt nur den eigenen Customer zurück (Customer-Self-Read), list_orders filtert auf `auth.customer_id`. Kein Cross-Customer-Leak.
4. **JSON-Schema-Output für tools/list** via Mini-Konverter (Zod → JSON-Schema). Plan-Revision-Kandidat: `zod-to-json-schema`-Lib.

### Bewusst nicht in v1
- OAuth-Flow für MCP-Connect ist über `/v1/auth/oauth/*` (M02b) abgedeckt — Client führt PKCE-Flow → JWT → MCP-Init.
- Streaming-Responses → Plan-Revision wenn Listen >500 üblich.

## 2026-11-17 — erster Lauf mit einem echten MCP-Ablauf (Staging)

`scripts/smoke-mcp.ts` spricht `/mcp` so an wie ein Client. Drei Funde, alle behoben:

1. `notifications/initialized` — von jedem Client direkt nach `initialize` gesendet — bekam `400 method_not_found`. Benachrichtigungen bekommen jetzt `202` ohne Body; `ping` wird beantwortet.
2. `tools/call` gab das rohe Ergebnis zurück. MCP verlangt `{ content: [{ type: "text", … }] }`; dazu `structuredContent`. Fachliche Fehler sind jetzt ein Ergebnis mit `isError` (das Modell sieht sie), kein HTTP-500.
3. MCP-Entwürfe tragen keine `warehouse_id`, und `reserve_stock` fiel auf das feste `"wh_default"` zurück, das es nirgends gibt — jede MCP-Bestellung scheiterte an FEFO. Rückfall ist jetzt das Standardlager des Tenants (`warehouses.is_default`).

Nachgewiesen gegen Staging: initialize → initialized → tools/list → search_products → create_order_draft → confirm_order mit Rechnung. `tests/routes/mcp-protocol.spec.ts` hält das Protokoll.
