---
module_id: M13_mcp_server
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P4_eventing_and_clients
---

# M13 — MCP Server

## Goal

MCP-Endpoint mit Tools, die 1:1 auf REST-API mappen — keine Parallel-Domain-Logik,
nur Tool-Wrapper. AI-Agents können bestellen, Preise erfragen, Bestellungen
abrufen — aber niemals ohne explizites Confirm-Tool committen.

## Non-Goals

- Keine eigene Persistenz (kommt alles aus der API)
- Kein eigenes Auth-System (siehe Open Question — entweder API-Keys oder OAuth)

## Success Criteria

Wie Build-Plan `M13_mcp_server.acceptance[]`. Zusätzlich:

- Claude Desktop kann sich verbinden, sucht „Rose 60", legt Draft an, confirmt
- Read-Scope-Token kann KEINE write-Tools aufrufen
- Tool-Schemas sind aus dem OpenAPI generiert, nicht handgepflegt

## Execution Intent (Vibe)

- Zwei-Tool-Pattern für Schreiben: `create_order_draft` + `confirm_order`.
  Niemals One-Shot-Commit.
- Tool-Beschreibungen sehr explizit zu Side-Effects
  („Diese Aktion verändert nicht den Bestand, das tut erst confirm_order")
- Conversational-Output: Tool-Result enthält das ganze Order-Doc plus
  human-readable summary

## Inputs Required

- M11 fertig (REST-API als Backend)
- Antworten auf Auth-Open-Question

## Deliverables

```
src/mcp/server.ts                      MCP-Endpoint /mcp
src/mcp/tools/                         search_products, get_price_quote, ...
src/mcp/auth.ts                        OAuth oder API-Key-basiert
src/mcp/tools.openapi-bridge.ts        Tool-Schemas aus OpenAPI
tests/mcp/...
```

## Happy Path

**Connect:**
1. AI-Client (Claude Desktop) öffnet OAuth-Flow gegen `/v1/oauth/authorize` (M02b) → erhält JWT.
2. Client postet JSON-RPC `initialize` an `POST /mcp` mit `Authorization: Bearer <jwt>`.
3. M13 verifiziert JWT (M02b-Middleware) → setzt `c.var.customer_id`, `c.var.tenant_id`, `c.var.scopes`.
4. Server antwortet mit Capabilities + `tools/list`-Hint.

**Tool-Discovery:**
5. `tools/list` → return Tool-Set, generiert aus OpenAPI-Pfaden via `tools.openapi-bridge.ts`. Beispiele: `search_products`, `get_price_quote`, `list_customers` (read-scope), `create_order_draft`, `confirm_order`, `cancel_order`, `get_order`, `list_orders`.

**Read-Tool:**
6. `tools/call search_products({q: "Rose 60"})` → Scope-Check (`read` reicht). Internal-Fetch `GET /v1/products/search?q=Rose+60` (tenant-scoped via JWT-Claims). Result-Mapping zu MCP-Tool-Output mit `{items[], next_cursor?}` und human-summary.

**Two-Step-Write:**
7. `tools/call create_order_draft({lines: [{sku_id, qty}]})` → Scope-Check (`write`). Internal `POST /v1/orders` → State `awaiting_confirmation`. Tool-Result enthält ganzen Order-Doc + Summary `"Entwurf für 3 Positionen, Total €X. Rufe confirm_order(order_id='ord_...') auf, um zu bestätigen."`. **KEIN automatisches Confirm.**
8. `tools/call confirm_order({order_id})` → State `confirmed`, Stock committed. Tool-Result enthält Doc + Summary `"Bestellung bestätigt. Lieferung am..."`.

**Cancel:**
9. `tools/call cancel_order({order_id, reason})` → analog.

**Anti-Auto-Commit-Guard:**
10. Falls Tool-Implementation einen Step erkennt, der ohne `confirm_order` zum Commit führen würde → `GH-MCP-002` 422.

## Error Paths

| Symptom                                  | Code            | Recovery |
|------------------------------------------|-----------------|----------|
| Token expired                            | `GH-AUTH-005`   | 401 |
| Tool ohne Scope aufgerufen               | `GH-AUTH-004`   | 403 |
| SKU-Resolution mehrdeutig                | `GH-MCP-001`    | 422; Tool-Result zeigt Alternativen |
| Agent versucht commit ohne confirm-Step  | `GH-MCP-002`    | 422 |

## Fallbacks

- API down → MCP-Tool gibt 503 mit Retry-Hint zurück; Agent kann erneut probieren

## Backwards-Compat Implications

- Tool-Namen (`search_products`, `create_order_draft`, …) permanent
- Tool-Input-Schemas additiv erweiterbar
- Output-Schema = Order-Document → alle Compat-Regeln gelten

## Open Questions

- [x] ~~**MCP-Auth-Modell: Per-Customer oder Per-Tenant?**~~ → **Resolved (2026-04-28): Per-Customer**.
  Konsistent mit Mobile-App-Auth (G4 → M02b_customer_auth, OAuth 2.1 + PKCE).
  Tenant-Service-Token bleibt nur für Tenant-interne Bot-Workflows reserviert.
  → **Modul jetzt blocked durch M02b** (muss erst gebaut sein).
- [x] ~~Streaming-Responses?~~ → **Nein für v1** (2026-04-28). Reason: Pagination
  reicht; Streaming Plan-Revision wenn Listen >500 üblich werden.

## Observability

- Tool-Aufruf-Häufigkeit pro Tool
- Confirm-Rate (wieviele Drafts werden tatsächlich bestätigt?)
- AI-Resolution-Konfidenz-Verteilung

## Test Strategy

- Mock-MCP-Client führt End-to-End-Flow durch
- Scope-Tests
- Two-Tool-Enforcement-Test (commit ohne confirm → blocks)

## Learnings

→ `learnings/M13-mcp-server.log.md`

## Plan Revisions Originating Here

(initial leer)
