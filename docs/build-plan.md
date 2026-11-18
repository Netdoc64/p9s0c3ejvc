# Build-Plan — JSON-Orchestrator für den App-Bau

## Idee

Ein einziges JSON-Dokument, das den **Bau** der Grosshandel-App vollständig
beschreibt: Stack-Entscheidungen, Module, Reihenfolge, Akzeptanzkriterien,
querschnittliche Standards. Wenn dieser Plan komplett ist, ist die eigentliche
Coding-Phase reine Ausführung — keine Re-Decisions mehr während der Implementierung.

**Goldene Regeln des Plans:**

1. **Jede Stack-Entscheidung trägt `reason` + `alternatives_rejected`** — sonst
   tritt sie später wieder auf.
2. **Jedes Modul hat `acceptance[]`** — fertig heisst messbar fertig, nicht
   „funktioniert auf meiner Maschine".
3. **`depends_on` ist hart** — kein Modul wird angefangen, bevor seine
   Vorgänger geliefert sind. Das ergibt einen DAG, der den Build linear macht.
4. **Open Questions blockieren** — solange `open_questions[]` für ein Modul
   nicht leer ist, darf es nicht in den Autopilot-Lauf.
5. **Standards einmal definieren, überall anwenden** (`cross_cutting`).
   Zeitstempel-Format, Money-Repräsentation, Error-Format — keine Diskussion mehr
   pro Modul.

## Vollbeispiel

```json
{
  "meta": {
    "schema_version": "build-plan/1.0",
    "project": "grosshandel",
    "version": "0.1.0",
    "pilot_tenant": "pilot",
    "design_intent": "API-first, MCP-native, multi-tenant Grosshandelsplattform auf Cloudflare. Branchenagnostisch durch Konfiguration (Steuerlogik, Verpackungseinheiten, Pflichtfelder), nicht Code-Fork.",
    "primary_vertical": "blumen-grosshandel",
    "consumer_channels": [
      { "id": "b2b_api",       "description": "Tenant-API-Key + HMAC; konsumieren Kunden-Backends/ERP-Systeme" },
      { "id": "mobile_app",    "description": "Endkunden-App (Florist bestellt bei Grosshändler); per-Customer-Auth nötig" },
      { "id": "mcp",           "description": "AI-Agents (Claude Desktop u.a.); per-Customer-Token, OAuth-Flow" },
      { "id": "web_portal",    "description": "(deferred D06) Pages-App, konsumiert API" },
      { "id": "whatsapp",      "description": "(deferred D02) via WhatsApp-Bridge" }
    ]
  },

  "orchestration": {
    "layer_path":         "docs/orchestration/",
    "naming_convention":  "<module_id>.md mit '_' → '-' (z.B. M08_stock_do → M08-stock-do.md)",
    "meta_files": {
      "readme":             "docs/orchestration/README.md",
      "vibecoding":         "docs/orchestration/_vibecoding.md",
      "errors":             "docs/orchestration/_errors.md",
      "self_optimization":  "docs/orchestration/_self-optimization.md",
      "backwards_compat":   "docs/orchestration/_backwards-compat.md",
      "template":           "docs/orchestration/_template.md"
    },
    "learnings_dir":      "docs/orchestration/learnings/",
    "agent_input_per_module": [
      "der eigene Modul-Knoten in dieser Datei",
      "die `path`-referenzierte Modul-Orchestration-Datei",
      "_vibecoding.md (immer)",
      "_errors.md (immer)",
      "_backwards-compat.md (immer)",
      "cross_cutting + stack_decisions (aus dieser Datei)"
    ]
  },

  "stack_decisions": [
    {
      "id": "runtime",
      "choice": "Cloudflare Workers",
      "alternatives_rejected": [
        { "option": "Node/Express",     "reason_rejected": "kein Edge, eigenes Hosting, Cold-Start-frei aber Ops-aufwändig" },
        { "option": "Bun + Hetzner",    "reason_rejected": "günstig, aber Multi-Region-Skalierung manuell" },
        { "option": "Vercel Functions", "reason_rejected": "Lock-in, schwächere D1-/Queue-/DO-Story" }
      ],
      "reason": "Konsistent mit dem bestehenden Chat-Backend (Hono + D1 auf CF). Edge-Latenz, integrierte Primitives (D1, DO, R2, Queues, KV) ohne externes Ops."
    },
    {
      "id": "framework",
      "choice": "Hono + @hono/zod-openapi",
      "alternatives_rejected": [
        { "option": "itty-router", "reason_rejected": "zu minimal, OpenAPI-Story fehlt" },
        { "option": "tRPC",        "reason_rejected": "starke TS-Kopplung, MCP-/HTTP-Clients ausserhalb TS-Welt schwierig" }
      ],
      "reason": "Hono ist auf CF-Workers Standard; zod-openapi gibt uns OpenAPI 3.1 als Single-Source-of-Truth — MCP-Tools und externe Clients lesen dasselbe Schema."
    },
    {
      "id": "orm",
      "choice": "drizzle-orm",
      "alternatives_rejected": [
        { "option": "kysely",          "reason_rejected": "kein Migrations-Tooling integriert" },
        { "option": "prisma",          "reason_rejected": "schlechte D1-Story, schwerer Edge-Footprint" },
        { "option": "raw SQL via D1",  "reason_rejected": "zu fehleranfällig bei wachsendem Schema" }
      ],
      "reason": "Type-safe, D1-nativ, Migrations integriert, leichter Footprint."
    },
    {
      "id": "validation",
      "choice": "Zod",
      "reason": "Source für Hono-Routes, OpenAPI und Order-Document-Schema gleichzeitig. JSON Schema wird daraus generiert für externe Konsumenten."
    },
    {
      "id": "tenancy",
      "choice": "shared D1 mit tenant_id auf jeder Tabelle",
      "alternatives_rejected": [
        { "option": "DB-pro-Tenant", "reason_rejected": "100 Tenants = 100 DBs verwalten, Cross-Tenant-Reports schwer; D1-Limits pro DB nicht das Bottleneck bei mittleren Tenants" }
      ],
      "reason": "Einfacher Betrieb, gemeinsame Migrations. Isolation durch Repository-Layer der `tenant_id` zwingend setzt; Vertragsbruch dort ist der einzige Lecks-Vektor und wird in Tests fixiert."
    },
    {
      "id": "auth",
      "choice": "X-Api-Key + HMAC + Idempotency-Key",
      "reason": "Konsistent mit dem bestehenden Chat-Backend. Keine neue Mechanik lernen."
    },
    {
      "id": "stock_concurrency",
      "choice": "Durable Object pro (tenant, sku)",
      "alternatives_rejected": [
        { "option": "D1-Row-Lock", "reason_rejected": "D1 hat keine starken Locks; Race Conditions bei gleichzeitigen Reservierungen unvermeidbar" },
        { "option": "KV mit CAS",  "reason_rejected": "KV ist eventual consistent, nicht für Bestand geeignet" }
      ],
      "reason": "DOs garantieren Single-Writer-Semantik pro SKU. Reservierungen mit TTL atomar."
    },
    {
      "id": "money_representation",
      "choice": "Integer in kleinster Währungseinheit (Cents)",
      "reason": "Float-Arithmetik ist bei Steuern + Mengenrabatt + FX nicht zuverlässig. Konversion nur am Rand (Display, OpenAPI documentation)."
    },
    {
      "id": "id_format",
      "choice": "Prefixed ULIDs (ord_..., cust_..., sku_...)",
      "reason": "Sortierbar, kollisionsarm, sofort an Logs/UI erkennbar welcher Typ."
    },
    {
      "id": "error_format",
      "choice": "RFC 7807 Problem Details",
      "reason": "Standard, OpenAPI-darstellbar, MCP-Tools können konsistent fehlerbehandeln."
    },
    {
      "id": "package_manager",
      "choice": "pnpm",
      "reason": "Sparsam mit Disk, schnell, gut für Workspace falls mehrere Workers."
    }
  ],

  "cross_cutting": {
    "ids":         { "format": "prefixed-ulid", "prefixes": { "tenant": "t_", "customer": "cust_", "product": "sku_", "order": "ord_", "invoice": "inv_", "shipment": "shp_", "payment": "pay_", "warehouse": "wh_", "price_list": "pl_" } },
    "timestamps":  { "format": "ISO-8601 UTC mit ms", "storage": "TEXT in D1, ISO-string" },
    "money":       { "storage": "INTEGER cents", "currency_field_required": true, "fx_snapshot_when": "tenant_currency != customer_currency", "rounding": "half_to_even" },
    "errors":      { "format": "RFC 7807 application/problem+json", "fields_required": ["type", "title", "status", "detail", "instance"] },
    "auth_tenant": {
      "use_for":     ["B2B-API-Konsumenten (Backend → Backend)"],
      "headers":     ["X-Api-Key", "X-Signature", "X-Timestamp", "X-Idempotency-Key"],
      "hmac_alg":    "HMAC-SHA256",
      "clock_skew_tolerance_sec": 300
    },
    "auth_customer": {
      "use_for":          ["Mobile App", "MCP-Agents", "Web-Portal (deferred)"],
      "scheme":           "OAuth 2.1 + PKCE",
      "access_token":     { "type": "JWT", "alg": "HS256", "secret_scope": "per-tenant", "ttl_sec": 900 },
      "refresh_token":    { "type": "opaque ULID", "ttl_sec": 7776000, "rotation": "on-use, replay-detected" },
      "magic_link":       { "code_length": 6, "ttl_sec": 600, "max_active_per_customer": 1 },
      "header":           "Authorization: Bearer <jwt>"
    },
    "logging":     { "format": "structured JSON", "fields_required": ["request_id", "tenant_id", "actor_id", "route", "duration_ms"], "no_pii_in_logs": true },
    "openapi":     { "version": "3.1", "served_at": "/openapi.json", "single_source": "Zod via @hono/zod-openapi" },
    "decisions":   { "rule": "Jede automatische Entscheidung im Order-Document trägt `decision_reason`. Gleiche Regel für alle Engines (pricing, tax, stock, gates)." },
    "testing":     { "framework": "vitest + miniflare", "coverage_target_pct": 80, "must_test": ["pricing engine", "tax engine", "stock DO", "gates", "auth middleware", "tenant isolation"] },
    "rate_limits": {
      "default_buckets_per_minute": {
        "auth_login":         5,
        "auth_token_refresh": 60,
        "magic_link_request": 3,
        "read_hot":           600,
        "read_warm":          120,
        "write_safe":         60,
        "write_critical":     20
      },
      "tier_multipliers": { "free": 1, "starter": 3, "pro": 10, "enterprise": 30 },
      "fail_mode_default":  "fail_open_with_alert",
      "headers_returned":   ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]
    },
    "slo": {
      "api_availability_30d":      0.999,
      "api_p99_latency_ms":        500,
      "auth_p99_latency_ms":       200,
      "stock_reserve_p99_ms":      100,
      "webhook_delivery_within_h": 1
    },
    "time_zones": {
      "tenant_default": "Europe/Amsterdam",
      "order_cutoff_logic_in":     "tenant_timezone",
      "audit_storage":             "UTC",
      "display":                   "customer_timezone OR tenant_default"
    },
    "pii_redaction": {
      "tagged_fields_in_zod":      true,
      "logger_strips_pii":         true,
      "hash_algo":                 "sha256",
      "tagged_field_examples":     ["customer.email", "customer.phone", "customer.name", "address.*", "auth.token_hash already-hashed"]
    },
    "client_versioning": {
      "required_headers_for_customer_routes": ["X-Client-Version", "X-Client-Platform"],
      "soft_sunset_window_days":   30,
      "min_supported_versions":    "see client_min_versions table per platform"
    }
  },

  "modules": [
    {
      "id": "M01_skeleton",
      "path": "docs/orchestration/M01-skeleton.md",
      "name": "Repo Skeleton + CI",
      "depends_on": [],
      "responsibility": "Baufähiges, getestetes Hono-Worker-Projekt mit D1 + DO + R2 + Queue Bindings, /health Endpoint, lokaler Dev-Loop, GitHub-Actions-CI.",
      "deliverables": [
        "wrangler.toml mit Bindings (DB, STOCK_DO, ASSETS, OUTBOX_QUEUE, KV)",
        "package.json (pnpm), tsconfig.json strict",
        "src/index.ts mit Hono-App, GET /health → 200",
        "drizzle.config.ts",
        "vitest.config.ts + miniflare-Setup",
        ".github/workflows/ci.yml: typecheck + test + build"
      ],
      "acceptance": [
        "pnpm install && pnpm test grün",
        "wrangler dev startet, GET /health gibt {status:'ok', version}",
        "CI grün auf einem PR"
      ],
      "open_questions": []
    },
    {
      "id": "M02_middleware",
      "path": "docs/orchestration/M02-middleware.md",
      "name": "Cross-Cutting Middleware",
      "depends_on": ["M01_skeleton"],
      "responsibility": "Request-ID, structured logging, RFC-7807-Errors, Auth (X-Api-Key + HMAC), Idempotency-Layer, Tenant-Resolution.",
      "deliverables": [
        "src/middleware/request-id.ts",
        "src/middleware/logger.ts",
        "src/middleware/error.ts (RFC 7807 Mapper)",
        "src/middleware/auth.ts (X-Api-Key Lookup → tenant; HMAC verify; clock-skew 5min)",
        "src/middleware/idempotency.ts (Key + tenant + route → cached response, TTL 24h, KV-backed)",
        "Tests für alle Middlewares"
      ],
      "acceptance": [
        "Fehlende API-Key → 401 Problem-JSON",
        "HMAC mismatch → 401",
        "Identisches Idempotency-Key gibt selbe Response zurück",
        "Cross-Tenant-Request mit Tenant-A-Key auf Tenant-B-Resource → 404 (nicht 403, kein Leak)"
      ],
      "open_questions": []
    },
    {
      "id": "M03_tenants",
      "path": "docs/orchestration/M03-tenants.md",
      "name": "Tenant + API-Key Model",
      "depends_on": ["M02_middleware"],
      "responsibility": "Datenmodell für Mandanten und ihre API-Keys, Bootstrap-Pfad zum Anlegen.",
      "deliverables": [
        "drizzle-schema: tenants, api_keys (mit hmac_secret)",
        "Migration",
        "src/repos/tenants.ts",
        "scripts/bootstrap-tenant.ts (CLI: name, country, currency → erzeugt tenant + first api_key)",
        "Tests"
      ],
      "acceptance": [
        "Bootstrap-CLI legt Pilot-Tenant + Test-Key an",
        "Auth-Middleware findet diesen Tenant über den Key"
      ],
      "open_questions": []
    },
    {
      "id": "M04_customers",
      "path": "docs/orchestration/M04-customers.md",
      "name": "Customers + VIES",
      "depends_on": ["M03_tenants"],
      "responsibility": "Kunden-Stammdaten mit VAT-ID-Validierung gegen VIES (mit Cache + Fallback) und Credit-Feldern.",
      "deliverables": [
        "drizzle-schema: customers, customer_vies_cache",
        "src/services/vies.ts (24h-Cache in KV, Fallback `unknown` wenn VIES down)",
        "REST: POST/GET/PATCH /customers, GET /customers/:id",
        "Zod-Schema mit OpenAPI-Annotations",
        "Tests inkl. VIES-Mock"
      ],
      "acceptance": [
        "VAT-ID DE/FR/NL-Beispiele werden korrekt validiert (Mock)",
        "VIES-Timeout → status='unknown', kein 5xx an den Client",
        "Cache wird nach 24h re-checked"
      ],
      "open_questions": []
    },
    {
      "id": "M02b_customer_auth",
      "path": "docs/orchestration/M02b-customer-auth.md",
      "name": "Customer Auth (OAuth 2.1 + PKCE + JWT)",
      "depends_on": ["M03_tenants", "M04_customers"],
      "responsibility": "Endkunden-Authentifizierung für Mobile App + MCP via OAuth 2.1 + PKCE; JWT-Access-Token + rotierender Refresh-Token; Magic-Link als Default-Login.",
      "deliverables": [
        "OAuth-Server-Endpoints /v1/oauth/{authorize,token,revoke}",
        "Magic-Link-Flow /v1/auth/magic-link/{request,verify}",
        "JWT-Sign+Verify (HS256, per-Tenant-Secret)",
        "Customer-Auth-Middleware (liest Bearer-JWT, setzt c.var.customer_id)",
        "Email-Adapter (Resend für v1)",
        "Auth-Migrations: authenticators, authorization_codes, refresh_tokens, magic_link_tokens",
        "Tests inkl. OAuth-Conformance-Suite-Subset"
      ],
      "acceptance": [
        "Mobile + MCP nutzen denselben OAuth-Code-Flow + PKCE",
        "JWT-Validation <2ms p99 (kein DB-Hit pro Request)",
        "Refresh-Rotation: alter Refresh nach Erneuerung 401",
        "Cross-Tenant-Token-Versuch → 404 (kein Leak)",
        "Replay-Detection auf Refresh-Token (Anomalie alarmiert)"
      ],
      "open_questions": []
    },
    {
      "id": "M05_products",
      "path": "docs/orchestration/M05-products.md",
      "name": "Products / SKUs + Catalog Import",
      "depends_on": ["M03_tenants"],
      "responsibility": "Produkt-Stammdaten mit Varianten, Verpackungseinheiten, Bildern, Bulk-Import via CSV.",
      "deliverables": [
        "drizzle-schema: products, product_variants, packaging_units",
        "REST: POST/GET/PATCH /products, GET /products/search?q=",
        "POST /products/import (multipart CSV, streaming, line-by-line Validation)",
        "POST /products/:id/images (R2-Upload, mehrere Varianten?)",
        "Tests inkl. 10k-Zeilen-CSV-Import (Streaming)"
      ],
      "acceptance": [
        "CSV mit 10k Zeilen importiert ohne Memory-Spike",
        "Suche findet 'Rose Naomi 60' bei Eingabe 'rote rose 60'",
        "Bilder landen in R2 mit deterministischem Pfad"
      ],
      "open_questions": []
    },
    {
      "id": "M06_pricing",
      "path": "docs/orchestration/M06-pricing.md",
      "name": "Pricing Engine",
      "depends_on": ["M04_customers", "M05_products"],
      "responsibility": "Pure Funktion (tenant, customer, sku, qty, date) → {final_price_per_unit, breakdown[], list_id, decision_reason}. Preisliste, Preisgruppe, Mengenstaffel, Sonderpreis pro Kunde.",
      "deliverables": [
        "drizzle-schema: price_lists, price_list_items, customer_special_prices, qty_breaks",
        "src/engines/pricing.ts (pure function, kein I/O — bekommt Daten injiziert)",
        "src/services/pricing-resolver.ts (lädt Daten und ruft Engine)",
        "REST: POST /pricing/quote (für Vorab-Preisanfragen)",
        "Tests: 20+ Szenarien (Listenpreis, Gruppe, Staffel, Sonderpreis, Kombi, Zeitfenster)"
      ],
      "acceptance": [
        "Reihenfolge ist deterministisch: Sonderpreis > Gruppen-Sonderpreis > Mengenstaffel > Liste",
        "Engine liefert immer `decision_reason` mit angewandter Regel",
        "Engine ist deterministisch — gleiche Inputs → gleiche Outputs (Test mit Snapshot)"
      ],
      "open_questions": []
    },
    {
      "id": "M07_tax",
      "path": "docs/orchestration/M07-tax.md",
      "name": "Tax Engine",
      "depends_on": ["M04_customers"],
      "responsibility": "Pure Funktion (tenant_country, customer_country, vat_id_status, b2b_b2c, sku_tax_class) → {scheme, rate_pct, rule_id, decision_reason}.",
      "deliverables": [
        "drizzle-schema: tax_rules (versionsiert mit valid_from/valid_to)",
        "src/engines/tax.ts (pure function)",
        "Initial-Regelset: DE-Standard 19%, EU-B2B-Reverse-Charge, EU-B2C-OSS, CH-MwSt 7.7%, Kleinunternehmer §19",
        "Tests: 15+ Szenarien"
      ],
      "acceptance": [
        "Tenant NL → Kunde DE B2B mit gültiger VAT-ID → reverse_charge_eu, 0%",
        "Tenant DE → Kunde DE B2B → standard, 19%",
        "Tenant DE → Kunde CH B2B → export, 0%",
        "VIES status='unknown' → behandelt wie ohne VAT-ID (B2C-Behandlung) MIT Warning"
      ],
      "open_questions": []
    },
    {
      "id": "M08_stock_do",
      "path": "docs/orchestration/M08-stock-do.md",
      "name": "Stock Durable Objects",
      "depends_on": ["M05_products"],
      "responsibility": "Pro (tenant, sku) ein DO. Atomares reserve / commit / release mit TTL-Cleanup. Multi-Lager.",
      "deliverables": [
        "src/do/stock.ts (Durable Object Class)",
        "DO-Methods: getAvailable, reserve(qty, ttl_sec) → reservation_id, commit(reservation_id), release(reservation_id)",
        "Alarm-API für TTL-Auto-Release",
        "drizzle-schema: stock_movements (Audit), warehouses",
        "REST: POST /stock/movements (manuelle Anpassungen, Inventur)",
        "Tests inkl. Concurrent-Reservation-Stress-Test"
      ],
      "acceptance": [
        "100 parallele reserve(1) auf Bestand 50 → genau 50 erfolgreich, Rest 'insufficient'",
        "TTL-Reservation wird nach Ablauf automatisch released",
        "stock_movements logged jede Mutation mit reason"
      ],
      "open_questions": []
    },
    {
      "id": "M09_order_doc",
      "path": "docs/orchestration/M09-order-doc.md",
      "name": "Order Document Schema + Storage",
      "depends_on": ["M03_tenants"],
      "responsibility": "Implementierung des Order-Document-Schemas (siehe order-document.md) als Zod, hybride D1-Persistenz: Header+Lines normalisiert für Queries, plan/gates/audit/issues als JSON-Spalte.",
      "deliverables": [
        "src/schemas/order.ts (Zod)",
        "drizzle-schema: orders (header + state + JSON spalten), order_lines (normalisiert)",
        "src/repos/orders.ts mit etag-basiertem Optimistic Locking",
        "JSON-Schema-Export (für externe Clients und MCP)",
        "Tests: Round-Trip Zod → DB → Zod"
      ],
      "acceptance": [
        "Order kann persistiert und exakt wiederhergestellt werden",
        "Concurrent Update mit altem etag → 409 Conflict",
        "JSON-Schema unter /schemas/order.json erreichbar"
      ],
      "open_questions": []
    },
    {
      "id": "M10_orchestrator",
      "path": "docs/orchestration/M10-orchestrator.md",
      "name": "Order Orchestrator (stateless Step-Runner)",
      "depends_on": ["M06_pricing", "M07_tax", "M08_stock_do", "M09_order_doc"],
      "responsibility": "Liest Order-Document, evaluiert Gates, findet nächsten erlaubten Step in plan.next_steps[], führt aus, schreibt zurück.",
      "deliverables": [
        "src/orchestrator/index.ts: runNextStep(doc) → doc",
        "src/orchestrator/gates.ts (deterministische Auswertung)",
        "src/orchestrator/state-machine.ts (allowed_transitions Validation)",
        "Step-Handler: resolve, reserve_stock, validate_gates, await_confirmation, commit_stock, emit_event",
        "Idempotenz pro Step über doc.id + step.id"
      ],
      "acceptance": [
        "Doppelter Aufruf von runNextStep mit demselben Doc-State führt nicht zu doppelter Reservierung",
        "Gate-Failure setzt Status auf 'on_hold' und issues.blocking[]",
        "Jeder Step hinterlässt einen Eintrag in plan.executed_steps[]"
      ],
      "open_questions": []
    },
    {
      "id": "M11_orders_api",
      "path": "docs/orchestration/M11-orders-api.md",
      "name": "Orders REST API",
      "depends_on": ["M10_orchestrator"],
      "responsibility": "HTTP-Adapter über Orchestrator: Draft anlegen, bestätigen, abbrechen, abrufen.",
      "deliverables": [
        "POST /orders (input → Doc draft → resolve & validate → return)",
        "POST /orders/:id/confirm",
        "POST /orders/:id/cancel  (mit reason)",
        "GET /orders/:id",
        "GET /orders?customer=&state=&created_after= (paginiert)",
        "OpenAPI-annotiert"
      ],
      "acceptance": [
        "End-to-end Test: Pilot-Tenant, Floraly-Kunde, 10 Karton Rosen → 200 mit awaiting_confirmation, dann confirm → confirmed",
        "Cancel released Stock-Reservation",
        "Cross-Tenant-Read → 404"
      ],
      "open_questions": []
    },
    {
      "id": "M12_outbox_webhooks",
      "path": "docs/orchestration/M12-outbox-webhooks.md",
      "name": "Outbox + Webhooks",
      "depends_on": ["M11_orders_api"],
      "responsibility": "State-Übergänge emittieren Events in Queue → Webhook-Worker liefert an Tenant-konfigurierte URLs mit HMAC-Sig + Retry.",
      "deliverables": [
        "drizzle-schema: webhook_subscriptions, webhook_deliveries (Audit)",
        "Outbox-Pattern: state transition schreibt event_to_emit in selbe Transaktion, separater Trigger pusht in Queue",
        "Queue-Consumer Worker: liefert mit Backoff (1s, 10s, 1m, 10m, 1h, 6h) max 6 Versuche",
        "REST: POST/GET/DELETE /webhooks",
        "Tests"
      ],
      "acceptance": [
        "order.confirmed bei Tenant mit 2 Subscriptions → 2 Deliveries, beide mit gültiger HMAC",
        "404 vom Receiver → Retry kommt",
        "Idempotency-Key in Header, damit Receiver dedupen kann"
      ],
      "open_questions": []
    },
    {
      "id": "M13_mcp_server",
      "path": "docs/orchestration/M13-mcp-server.md",
      "name": "MCP Server",
      "depends_on": ["M11_orders_api", "M02b_customer_auth"],
      "responsibility": "MCP-Endpoint mit Tools, die 1:1 auf REST-API mappen — KEIN Parallel-Code, nur Tool-Wrapper.",
      "deliverables": [
        "src/mcp/server.ts (auf /mcp)",
        "Tools: search_products, get_price_quote, list_customers, create_order_draft, confirm_order, cancel_order, get_order, list_orders",
        "OAuth-Flow für MCP-Auth (Client-Credentials oder Per-User)",
        "Conversational Confirmation-Pattern: create_order_draft gibt Doc zurück, Agent muss explizit confirm_order aufrufen",
        "Tests mit MCP-Test-Client"
      ],
      "acceptance": [
        "Claude Desktop kann sich verbinden, search_products findet 'Rose 60', create_order_draft + confirm_order funktioniert",
        "Agent ohne human-in-the-loop kann KEINE Order ohne explizites confirm_order committen",
        "MCP-Token mit scope='read' kann nicht confirmen"
      ],
      "open_questions": []
    },
    {
      "id": "M14_seed_pilot",
      "path": "docs/orchestration/M14-seed-pilot.md",
      "name": "Pilot-Seed (Blumen-Grosshandel)",
      "depends_on": ["M11_orders_api"],
      "responsibility": "Realistischer Datensatz, damit Pilot ohne manuelle Eingabe lauffähig ist.",
      "deliverables": [
        "scripts/seed-pilot.ts: Tenant, 3 Test-Kunden (DE/NL/CH), 50 Test-SKUs (Rosen, Tulpen, Gerbera in versch. Längen), Preisliste, Mengenstaffel-Beispiele, Steuerregeln",
        "Smoke-Test-Skript, das eine End-to-End-Order durchspielt"
      ],
      "acceptance": [
        "Frischer DB-Stand: pnpm seed:pilot && pnpm smoke → grün"
      ],
      "open_questions": []
    },
    {
      "id": "M15_rate_limiting",
      "path": "docs/orchestration/M15-rate-limiting.md",
      "name": "Rate-Limiting + Quotas",
      "depends_on": ["M02_middleware", "M03_tenants"],
      "responsibility": "Token-Bucket-Rate-Limits pro (Tenant, Customer, Endpoint-Klasse); Tier-Quotas; Headers, Fail-Open-Default.",
      "deliverables": [
        "src/middleware/rate-limit.ts mit KV+DO-Hybrid",
        "drizzle-schema: rate_limit_tiers, tenant_rate_overrides",
        "Header-Set X-RateLimit-*",
        "Tests inkl. Race-Test 1000 parallel auf 100-Limit"
      ],
      "acceptance": [
        "Login-Bucket strikt (DO-backed): 6. Versuch in 1min → 429",
        "Cross-Customer-Isolation: A's Limit blockiert B nicht",
        "KV-Down → fail-open mit Alert"
      ],
      "open_questions": []
    },
    {
      "id": "M16_secrets_rotation",
      "path": "docs/orchestration/M16-secrets-rotation.md",
      "name": "Secrets Rotation",
      "depends_on": ["M03_tenants", "M17_cron_jobs"],
      "responsibility": "Doppel-Reader-Rotation für Tenant-HMAC, JWT-Secret und externe API-Keys; 90-Tage-Cron + manuelle CLI; 7d Karenzfrist.",
      "deliverables": [
        "Schema-Erweiterung: *_previous + *_previous_until in tenants",
        "src/services/rotation.ts",
        "scripts/rotate-secrets.ts CLI",
        "Cron-Hook (M17)",
        "secret.rotated-Webhook-Topic"
      ],
      "acceptance": [
        "Rotation ohne Downtime — alte HMAC + neue beide gültig 7d",
        "Cleanup nach Karenz",
        "Concurrent-Rotation rejected"
      ],
      "open_questions": []
    },
    {
      "id": "M17_cron_jobs",
      "path": "docs/orchestration/M17-cron-jobs.md",
      "name": "Cron Jobs / Scheduled Worker",
      "depends_on": ["M01_skeleton", "M02_middleware"],
      "responsibility": "Zentraler Scheduled-Worker: Outbox-Sweep, TTL-Cleanups, VIES-Refresh, Stock-Alerts, Daily-Reports, Secret-Rotation, FEFO-Recheck, Pricing-Feed-Pull.",
      "deliverables": [
        "wrangler.toml Cron-Triggers",
        "src/cron/{index,registry,jobs/*}.ts",
        "drizzle-schema: cron_runs",
        "DO-Lock mit TTL pro Job",
        "Auto-Pause nach 3 Failures"
      ],
      "acceptance": [
        "Job-Idempotenz: Doppel-Run = Single-Effekt",
        "Crash mid-job → Lock-TTL released, nächster Trigger nimmt",
        "Failure-Audit in cron_runs"
      ],
      "open_questions": []
    },
    {
      "id": "M18_observability",
      "path": "docs/orchestration/M18-observability.md",
      "name": "Observability + SLOs",
      "depends_on": ["M02_middleware"],
      "responsibility": "Strukturierte Logs mit PII-Redaction; Counter/Histogram/Gauge; SLO-Definitionen als Code; Logpush nach R2; Alerting-Regeln; Runbooks.",
      "deliverables": [
        "src/observability/{pii,metrics,slos}.ts",
        "Logger-Erweiterung mit Field-Tagging-Stripping",
        "monitoring/{alerts.json, dashboards/*.json}",
        "docs/runbooks/ pro SLO-Verletzung",
        "Logpush-Konfig (30d hot in R2, 7y cold archive)"
      ],
      "acceptance": [
        "PII-Felder im Body landen als Hash im Log",
        "SLO-Compliance-Suite: Lasttest validiert Budget",
        "Alert-Routing-Test: künstlicher Failure kommt an"
      ],
      "open_questions": []
    },
    {
      "id": "M19_disaster_recovery",
      "path": "docs/orchestration/M19-disaster-recovery.md",
      "name": "Disaster Recovery + Backup",
      "depends_on": ["M03_tenants", "M17_cron_jobs", "M18_observability"],
      "responsibility": "Daily-D1-Export nach R2 mit Cross-Region-Replikation; DO-Snapshot-Skripte; Restore-Runbook; jährlicher DR-Drill auf Staging. RTO 4h / RPO 1h.",
      "deliverables": [
        "scripts/backup-d1-daily.ts (Cron-Hook)",
        "scripts/backup-do-stock.ts",
        "scripts/restore-{d1,do-stock}.ts",
        "docs/runbooks/disaster-restore.md",
        ".github/workflows/dr-drill.yml (jährlich)"
      ],
      "acceptance": [
        "Daily-Backup grün mit Hash-Verify",
        "DR-Drill auf Staging vollständig restored + Smoke grün",
        "Runbook-Walkthrough von Junior-Engineer ohne externe Hilfe machbar"
      ],
      "open_questions": []
    },
    {
      "id": "M20_pricing_feeds",
      "path": "docs/orchestration/M20-pricing-feeds.md",
      "name": "Pricing Feeds (Auktionspreise)",
      "depends_on": ["M06_pricing", "M17_cron_jobs"],
      "responsibility": "Daily-Cron pulled Auktions-Tagespreise (Aalsmeer / RBC / CSV-Generic), erzeugt neue price_list-Version, atomarer Cutover; Drift-Detection >50% blockiert Auto-Switch.",
      "deliverables": [
        "src/services/pricing-feeds/{registry, adapter.aalsmeer, adapter.rbc, adapter.csv-generic, resolver}.ts",
        "src/cron/jobs/pricing-feed-pull.ts",
        "drizzle-schema: tenant_pricing_feeds, feed_runs",
        "POST /pricing-feeds/test (manueller Trigger)"
      ],
      "acceptance": [
        "Adapter-Roundtrip mit Fixture-Files",
        "Drift > 50% auf > 5% SKUs blockiert Switch",
        "Feed-Down → letzte Liste aktiv mit Alert"
      ],
      "open_questions": []
    },
    {
      "id": "M21_perishability",
      "path": "docs/orchestration/M21-perishability.md",
      "name": "Perishability + FEFO",
      "depends_on": ["M08_stock_do", "M17_cron_jobs", "M05_products"],
      "responsibility": "Stock-DO mit Batches (Wareneingang + MHD); Reservierung greift FEFO mit min_shelf_life_days-Filter; Bruch/Schwund/Qualität als kategorisierte Stock-Movements; Daily-FEFO-Recheck.",
      "deliverables": [
        "Erweiterte src/do/stock.ts mit Batch-State + Migrations-Skript",
        "drizzle-schema: stock_batches; products.is_perishable, default_shelf_life_days; tenants.min_shelf_life_days",
        "src/cron/jobs/fefo-recheck.ts",
        "POST /stock/batches (Wareneingang)"
      ],
      "acceptance": [
        "FEFO-Reservierung greift ältesten validen Batch",
        "Multi-Batch-Reserve atomar",
        "DO-State-Migration v1→v2 ohne Downtime"
      ],
      "open_questions": []
    },
    {
      "id": "M22_invoice_pdf",
      "path": "docs/orchestration/M22-invoice-pdf.md",
      "name": "Invoice PDF + Signed URLs",
      "depends_on": ["M11_orders_api", "M07_tax"],
      "responsibility": "PDF-Rechnungen via pdf-lib im Worker; Pflichtangaben pro Country (DE/NL/CH); R2-Storage immutable; Signed-URLs (7d Customer / 90d Tenant).",
      "deliverables": [
        "src/services/invoice-pdf/{generator, template.standard, country-requirements, branding}.ts",
        "src/orchestrator/handlers/generate-invoice.ts (M10-Step)",
        "drizzle-schema: invoices, invoice_documents",
        "GET /invoices/:id (signed URL)"
      ],
      "acceptance": [
        "Snapshot-Tests pro Country mit allen Pflichtangaben",
        "Idempotenz: Doppel-Generation = ein R2-File",
        "Rechnungsnummer-Lückenlosigkeit unter Concurrent-Confirm"
      ],
      "open_questions": []
    },
    {
      "id": "M23_push_notifications",
      "path": "docs/orchestration/M23-push-notifications.md",
      "name": "Push Notifications (Mobile)",
      "depends_on": ["M12_outbox_webhooks", "M02b_customer_auth"],
      "responsibility": "APNs (iOS) + FCM (Android) Adapter; Device-Registry pro Customer; Throttling + Quiet-Hours; konsumiert M12-Events als interner Subscriber.",
      "deliverables": [
        "drizzle-schema: devices",
        "src/services/push/{apns, fcm, registry, throttler, quiet-hours}.ts",
        "POST/DELETE /devices",
        "src/workers/push-deliverer.ts (Queue-Consumer)"
      ],
      "acceptance": [
        "Order-Confirmed → Push <10s p99",
        "410/404 → Device-Token invalidiert + Auto-Cleanup",
        "Throttle: 10 Events in 1min → max 5 Pushes"
      ],
      "open_questions": []
    },
    {
      "id": "M24_client_versioning",
      "path": "docs/orchestration/M24-client-versioning.md",
      "name": "Client Versioning + Forced Upgrade",
      "depends_on": ["M02_middleware", "M23_push_notifications"],
      "responsibility": "Pflicht-Header X-Client-Version + X-Client-Platform für Customer-Routes; SemVer-Vergleich gegen min_supported_version; Soft-Sunset 30d via Push; 426 bei Hard-Cutoff.",
      "deliverables": [
        "src/middleware/client-version.ts",
        "drizzle-schema: client_min_versions",
        "src/services/version-cmp.ts (SemVer)",
        "POST /admin/client-versions",
        "src/cron/jobs/client-sunset-notify.ts"
      ],
      "acceptance": [
        "Header-Parsing aller Edge-Cases",
        "SemVer-Vergleich (1.4.2 < 1.4.10, 2.0.0-beta1 < 2.0.0)",
        "Sunset-Push 30d vor Hard-Cutoff"
      ],
      "open_questions": []
    }
  ],

  "phases": [
    {
      "id": "P1_foundation",
      "modules": ["M01_skeleton", "M02_middleware", "M03_tenants", "M17_cron_jobs", "M18_observability"],
      "exit_criteria": "Authentifizierte, getenanted Hono-App auf CF deployed; CI grün; Pilot-Tenant per CLI anlegbar; Cron-Worker läuft; SLO-Monitoring + Logpush aktiv."
    },
    {
      "id": "P2_domain",
      "modules": ["M04_customers", "M02b_customer_auth", "M05_products", "M06_pricing", "M07_tax", "M08_stock_do", "M21_perishability", "M15_rate_limiting", "M16_secrets_rotation", "M24_client_versioning"],
      "exit_criteria": "Stammdaten + Engines (pricing, tax, stock-mit-FEFO) eigenständig getestet & via REST nutzbar; Endkunden-Auth funktional; Rate-Limiting + Secrets-Rotation + Client-Versioning produktiv."
    },
    {
      "id": "P3_orders",
      "modules": ["M09_order_doc", "M10_orchestrator", "M11_orders_api", "M20_pricing_feeds", "M22_invoice_pdf"],
      "exit_criteria": "End-to-End-Order via REST: draft → confirm → confirmed mit Stock-Commit, PDF-Rechnung in R2, Pricing-Feed läuft täglich, Audit-Trail komplett."
    },
    {
      "id": "P4_eventing_and_clients",
      "modules": ["M12_outbox_webhooks", "M13_mcp_server", "M23_push_notifications", "M14_seed_pilot"],
      "exit_criteria": "MCP-Client kann eine Pilot-Bestellung durchführen; Webhooks gehen raus an Tenants; Push erreicht Mobile-Devices; Smoke-Test grün."
    },
    {
      "id": "P5_hardening",
      "modules": ["M19_disaster_recovery"],
      "exit_criteria": "DR-Drill auf Staging erfolgreich durchgelaufen; Backup-Verify-Cron grün; Runbooks gereviewed."
    }
  ],

  "deferred": [
    { "id": "D01_buchhaltung_eu",      "reason": "v1 läuft mit eigener interner Rechnungs-ID; buchhaltung_eu-Push als Webhook-Subscriber später" },
    { "id": "D02_whatsapp_channel",    "reason": "Erst MCP + Web stabil, dann die WhatsApp-Bridge als zusätzlicher Kanal" },
    { "id": "D03_returns_credit_notes","reason": "Retouren und Reklamationen implementiert. D03 bleibt für den Pilotbetrieb zurückgestellt, bis die Edge-Verträge abgeglichen sind." },
    { "id": "D04_partial_shipments",   "reason": "Saga-Pattern, danach" },
    { "id": "D05_multi_currency_fx",   "reason": "Pilot ist EUR-only" },
    { "id": "D06_admin_ui",            "reason": "Pages-App separat, konsumiert nur die API; nach v1 Backend stabil" },
    { "id": "D07_payments_stripe",     "reason": "Pilot 'auf Rechnung'; Stripe später" }
  ],

  "risks": [
    { "id": "R1", "risk": "D1 Schreibdurchsatz bei vielen kleinen Tenants",        "mitigation": "Outbox-Schreiben gebündelt, KV/DO für Hot-Path; Monitoring ab P3" },
    { "id": "R2", "risk": "Tenant-Leak durch fehlenden tenant_id-Filter in Repo",    "mitigation": "Repo-Layer mit zwingendem ctx-Parameter; Test 'cross-tenant access' in jedem Modul" },
    { "id": "R3", "risk": "VIES-Downtime blockiert Customer-Onboarding",            "mitigation": "Cache + 'unknown'-Fallback; Tax-Engine behandelt 'unknown' wie B2C mit Warning" },
    { "id": "R4", "risk": "MCP-Agent committet versehentlich Order ohne Bestätigung","mitigation": "Zwei-Tool-Pattern (create_draft + confirm), Default-State 'awaiting_confirmation'" },
    { "id": "R5", "risk": "Rechnungsnummer-Kreis nicht lückenlos bei DO-Crashes",    "mitigation": "Single-DO pro Tenant für Nummernvergabe; Reservation vor Vergabe" }
  ],

  "global_questions": [
    {
      "id": "G1",
      "question": "Monorepo (pnpm workspace) oder Single-Worker mit allen Routes?",
      "status": "resolved",
      "resolved_at": "2026-04-28",
      "decision": "Single-Worker",
      "reason": "v1 hat überschaubare Worker-Anzahl (API + MCP-Endpoint + Outbox-Sweeper alle im selben Hono-App). Workspace-Tooling kostet 1–2 Tage in M01 ohne sofortigen Nutzen. Migration zu Workspace ist später Plan-Revision-konform machbar (Code-Bewegung, keine ID-Änderung), wenn Bundle-Size oder Throughput-Profile auseinanderlaufen."
    },
    {
      "id": "G2",
      "question": "D1-Primary-Region?",
      "status": "resolved",
      "resolved_at": "2026-04-28",
      "decision": "weur (West Europe)",
      "reason": "Pilot-Tenant in NL, EU-Kunden DE/NL/CH. Schreib-Latenz minimal, Read-Replikate global. Region-Wechsel später ist machbar aber teuer (D1 Migration), darum gleich richtig."
    },
    {
      "id": "G3",
      "question": "Audit-Sichtbarkeit: intern only oder Tenant-sichtbar?",
      "status": "resolved",
      "resolved_at": "2026-04-28",
      "decision": "Hybrid: internes Voll-Audit + Tenant-/Endkunden-sichtbares Vorgänge-Log",
      "reason": "Bei Mobile App + vielen Endkunden ist Selbstbedienung Pflicht — sonst wird Support-Last untragbar. Order-Document hat ohnehin schon zwei Schichten: tenant-tauglich (state.history, plan.executed_steps, issues) vs. intern (audit.ai_decisions, rejected_alternatives, decision_reason-Internas). Wir brauchen eine Sichtbarkeits-Markierung pro Feld im Schema (Vorschlag: `_visibility: \"tenant\"|\"customer\"|\"internal\"`), Renderer filtert je nach Konsument. Spät erweiterbar, aber von Tag 1 sauber getrennt."
    },
    {
      "id": "G4",
      "question": "Endkunden-Auth-Mechanismus für Mobile App und MCP?",
      "status": "open",
      "context": "Tenant-API-Key + HMAC ist für B2B-Backends, nicht für Endkunden-Devices. Mobile App + MCP brauchen per-Customer-Auth.",
      "options": [
        "JWT mit Refresh-Token (klassischer Mobile-Pattern, kurzes Access-Token, langes Refresh)",
        "OAuth 2.1 Authorization-Code-Flow mit PKCE (Standard für Mobile + MCP gleichermassen, Cloudflare hat keinen nativen IdP, müsste self-hosted oder über Auth0/Clerk/WorkOS)",
        "Hybrid: OAuth nach aussen (Mobile + MCP), intern als JWT validiert"
      ],
      "implications": [
        "Eigenes Modul nötig — Vorschlag M02b_customer_auth, abhängig von M03 (Tenant)",
        "Customer-Resource bekommt 'login_identifier' (Email, Telefon) und 'authenticators' (Passwort-Hash, Passkey, Magic-Link-Token)",
        "Scope-Modell: customer_self (eigene Daten + Bestellungen), customer_proxy_for_org (für Mehr-Personen-Florist-Konten)"
      ]
    }
  ]
}
```

## Wie der Autopilot später läuft

1. **Pre-Flight:** `global_open_questions` und `modules[].open_questions` leerräumen.
   Solange offen, blockiert.
2. **Phase für Phase:** P1 → P2 → P3 → P4. Innerhalb einer Phase parallele Module
   möglich (z.B. M06 + M07 + M08 sind unabhängig).
3. **Pro Modul:** Coding-Agent bekommt nur den Modul-Knoten + `cross_cutting` +
   `stack_decisions`. Akzeptanzkriterien sind die Tests.
4. **Exit-Kriterium der Phase** ist ein integrativer Smoke-Test, nicht nur Modul-Tests.
5. **Risks** werden phasenweise re-evaluiert. Wenn R2 in P2 nicht durch Tests
   abgedeckt ist, blockiert P3.

## Status — Plan vollständig (2026-04-28, Hardening-Pass abgeschlossen)

**Plan ist autopilot-ready inkl. Hardening.** 25 Module gesamt (15 Core + 10 Hardening), alle Build-blockierenden Open Questions entschieden, 5 Phasen statt 4.

### Globale Decisions

- ✅ **G1** Single-Worker (kein Monorepo für v1) — Migration zu Workspace ist Plan-Revision-konform machbar
- ✅ **G2** D1-Region `weur`
- ✅ **G3** Audit hybrid (intern voll + Tenant-/Endkunden-sanitized via `_visibility`)
- ✅ **G4** Endkunden-Auth via OAuth 2.1 + PKCE, JWT-Access-Token + rotierender Refresh, Magic-Link als Default-Login → neues **M02b_customer_auth** in P2

### Modul-Decisions (Auszüge — Volltext in den jeweiligen Orchestration-Files)

**Core (P1–P4):**

| Modul | Wichtigste Entscheidungen |
|---|---|
| **M02 middleware** | Idempotency global 24h; Workers-Logs für v1 |
| **M03 tenants** | Mehrere API-Keys mit `revoked_at`-Rotation; Soft-Delete |
| **M04 customers** | Credit-Limit Tenant-Currency only; Soft-Delete + DSGVO-Pseudonymisierungs-Service; Adressen embedded JSON |
| **M02b auth** | OAuth 2.1 + PKCE (Mobile + MCP gleicher Flow); JWT HS256 per-Tenant-Secret; Magic-Link Default; Resend für Email |
| **M05 products** | Bilder on-demand via CF Image Resizing; Varianten = eigene SKUs mit `parent_sku_id`; `tax_class` Enum auf SKU |
| **M06 pricing** | Mengenstaffel pro Line; deterministische Regel-Reihenfolge (customer_special > group_special > promo > qty_break > list); `round_half_to_even` |
| **M07 tax** | `standard`/`reduced`/`zero` vom Start; OSS deferred; CH-MwSt 8.1% von Tag 1 |
| **M08 stock** | Strikt pro Lager v1; `allow_backorder=false` Default mit SKU-Override; DO pro `(tenant, warehouse, sku)` |
| **M09 order-doc** | Sub-Documents als eigene `doc_type`s mit `parent_order_id`; drei separate JSON-Spalten (plan/audit/gates_log) |
| **M10 orchestrator** | Hybrid Auto-Chain: internal-Steps chainen, external/user-interaction brechen |
| **M11 orders-api** | v1-Filter: state/customer_id/created_after/before; opaque Cursor |
| **M12 webhooks** | Event-Schema-Version im Topic-Name (`order.confirmed.v1`) |
| **M13 mcp** | Per-Customer-Auth (über M02b); kein Streaming v1 |
| **M14 seed** | Faker mit fixed Seed, deterministische IDs |

**Hardening (P1–P5):**

| Modul | Wichtigste Entscheidungen |
|---|---|
| **M15 rate-limiting** | KV-Buckets default, DO für strikte Klassen (Login/Refresh/Magic-Link); 4 Tiers (free/starter/pro/enterprise); Fail-Open mit Alert |
| **M16 secrets-rotation** | Doppel-Reader 7d Karenz; 90-Tage-Cron + manueller CLI; `secret.rotated`-Webhook-Topic |
| **M17 cron-jobs** | Zentraler Scheduled-Worker; DO-Lock mit TTL pro Job; Auto-Pause nach 3 Failures |
| **M18 observability** | SLO-Definitionen als Code (99.9% Verfügbarkeit, p99 <500ms hot-path); PII-Redaction via Zod-Field-Tagging; Logpush 30d hot + 7y cold |
| **M19 disaster-recovery** | RTO 4h / RPO 1h; Daily-D1-Export + Cross-Region; jährlicher DR-Drill auf Staging |
| **M20 pricing-feeds** | Aalsmeer FloraHolland + RBC + CSV-Generic; Drift >50% auf >5% SKUs blockiert Auto-Switch |
| **M21 perishability** | DO mit Batches statt Single-Counter; FEFO-Reservierung; Default `min_shelf_life_days=3` |
| **M22 invoice-pdf** | `pdf-lib` via wasm im Worker; immutable R2-Storage; Country-Requirements DE/NL/CH; signed URLs 7d/90d |
| **M23 push** | Direkt APNs HTTP/2 + FCM v1 (kein Drittanbieter); Throttle 5/min; Quiet-Hours 22-7 lokal |
| **M24 client-versioning** | Pflicht-Header X-Client-Version/Platform für Customer-Routes; SemVer; Soft-Sunset 30d mit Push-Notification vor Hard-Cutoff |

### Restliche Plan-Revision-Kandidaten (nicht Build-Blocker)

Diese Punkte sind bewusst aufgeschoben, kommen als spätere Plan-Revisions wenn Realität sie hochdrückt:

- M02 Logger-Sink (Logpush)
- M02b Customer-zu-Organisation-Mapping (Mehr-Personen-Florist-Konten)
- M07 OSS-Aktivierung (wenn B2C-Kanäle relevant)
- M13 Streaming-Responses (wenn Listen >500 üblich)
- D01–D07 (deferred): buchhaltung_eu-Push, WhatsApp-Channel, [Retouren und Reklamationen (D03)](#d03-retouren-und-reklamationen-über-alle-edges), Teillieferungen, Multi-Currency, Admin-UI, Stripe

### Build-Reihenfolge (Autopilot)

```
P1_foundation         M01 → M02 → M03 → M17 → M18           (5 Module, mostly sequenziell — M17/M18 nach M02)
P2_domain   parallel: M04, M02b, M05, M06, M07, M08          (Core-Domain)
            +         M15, M16, M21, M24                     (Hardening, parallel zu Core)
P3_orders             M09 → M10 → M11 → M22 → M20            (M22 + M20 nach M11)
P4_eventing_clients   M12, M13, M23, M14                     (M14 zuletzt — Pilot-Seed)
P5_hardening          M19                                    (DR-Drill nach Prod-Up)
```

Innerhalb einer Phase sind Module mit nicht-überschneidenden `depends_on` parallelisierbar.

**Nächster Schritt: Phase P1 anstossen** — M01-skeleton ist `specified` und unblocked. Empfohlene Reihenfolge in P1: M01 → M02 → (M03 parallel M17 parallel M18).

## D03 Retouren und Reklamationen über alle Edges

**Status** Der führende B2B-Fallstand, die Kundensicht und die Lieferantenübergabe sind in diesem Repository implementiert. Der Abgleich mit den getrennt entwickelten Edges steht aus. [Schnittstellen und Einrichtung](#schnittstellen-und-einrichtung)

### Ablauf entlang der Lieferkette

1. **Kleinunternehmer oder B2B meldet den Fall.** Der jeweilige Edge erfasst eine Retoure oder einen Mangel mit Bestell- und Lieferposition, Menge, Grund und bei Bedarf Nachweisen. Der B2B-Edge speichert den Fall dauerhaft und antwortet mit gemeinsamer Fall-ID und Version. Die Meldung kann damit bestätigt sein, während die Prüfung noch läuft.
2. **B2B prüft und ermittelt den nächsten Beteiligten.** Maßgeblich ist die tatsächliche Liefer- oder Beschaffungszuordnung je Position, bei Bedarf bis zur Charge. Betrifft ein Fall mehrere Lieferanten, erhält jeder nur seine zugeordneten Positionen und Mengen. Fehlt die Zuordnung, bleibt die Position zur manuellen Klärung beim B2B-Edge.
3. **Die zuständige Seite übernimmt den Fall.** Der B2B-Edge übergibt die betroffenen Positionen synchron an den Lieferanten-Edge. Gibt es eine weitere vorgelagerte Stufe, gilt dieselbe Regel für diese Übergabe. Der empfangende Edge bestätigt die dauerhafte Annahme der Aufgabe. Eine Entscheidung über den Anspruch folgt als eigener Schritt. Die Rückwärtsroute folgt der konkreten Lieferkette, etwa `Kleinunternehmer → B2B → Lieferant`.
4. **Entscheidung und Ware werden getrennt verfolgt.** Der Lieferanten-Edge meldet Entscheidung und Wareneingang für seine Positionen synchron an den B2B-Edge zurück. Eine Reklamation kann je Position mit Gutschrift, Ersatz oder Ablehnung enden. Die Entscheidung enthält gegebenenfalls die genehmigte Rücksendemenge und das Empfangslager. Teilmengen mehrerer Fälle dürfen zusammen die gelieferte Menge je Lieferposition nicht überschreiten. Das Empfangslager bestätigt den tatsächlichen Eingang und die Prüfung. Erst die Freigabe macht die Ware im Bestand wieder verkäuflich. Ein genehmigter Fall kann auch ohne Rücksendung erledigt werden.
5. **Jede Geschäftsbeziehung rechnet separat ab.** Gutschrift oder Ersatz gegenüber dem Kleinunternehmer und der Ausgleich zwischen B2B und Lieferant haben jeweils einen eigenen Status und eigene Belegreferenzen. Der B2B-Edge kann den Kundenfall abschließen, während der Lieferantenausgleich weiterläuft. Die geplanten Retouren- und Gutschriftdokumente bleiben mit der jeweiligen Ursprungsbestellung verknüpft. [Order-Dokument](order-document.md)

### Synchronisation und Fehlerfälle

- **Ein verbindlicher Fallstand.** Der B2B-Edge führt im Entwurf den versionierten Fallstand. Beteiligte Edges lesen ihre freigegebene Sicht synchron von dort. Pro Position werden Bearbeitungszuständigkeit, Entscheidung, Warenweg und Abrechnung getrennt ausgewiesen. Jeder Edge authentifiziert den Absender und prüft dessen Berechtigung für Fall und Position.
- **Erfolg erst nach bestätigter Übergabe.** Der führende Edge speichert die Übergabeabsicht, der Empfänger bestätigt die dauerhafte Annahme, und der führende Edge schreibt daraufhin die neue Zuständigkeit. Erst dann meldet der Aufruf Erfolg und der Empfänger darf die Aufgabe bearbeiten. Bei einem Timeout bleibt die bisherige Zuständigkeit bis zur bestätigten Übergabe bestehen. Der Vorgang ist als offen abfragbar. Eine Wiederholung mit derselben Befehls-ID holt die bestehende Empfangsbestätigung ab oder führt die offene Übergabe zu Ende.
- **Wiederholbare Befehle.** Der Vertrag braucht eine gemeinsame Fall-ID, die Positionsreferenz, eine stabile Befehls-ID und die erwartete Fallversion. Eine Wiederholung desselben Befehls liefert das bereits gespeicherte Ergebnis. Ein neuer Befehl mit veralteter Version meldet einen Konflikt. Wareneingänge, Bestandsfreigaben und Gutschriften haben zusätzlich je einen stabilen Geschäftsschlüssel, damit Wiederholungen keine zweite Buchung erzeugen.
- **Benachrichtigungen nach dem Speichern.** Die vorhandene Outbox kann Beteiligte über Änderungen informieren. Edges holen den verbindlichen Stand über die Fallabfrage. Die Webhook-Zustellung garantiert keine Reihenfolge pro Bestellung. [Outbox und Webhooks](orchestration/M12-outbox-webhooks.md#non-goals)

### Abgleich und Abnahme

- Sobald die Edge-Verträge vorliegen, gemeinsam festlegen, wer den Fallstand führt, wie Bestell-, Liefer- und Beschaffungspositionen verknüpft sind und welche Rollen welche Entscheidungen, Warenbewegungen und Belege schreiben dürfen. Danach Routen, Payloads, Authentifizierung und Fehlerantworten aufeinander abgleichen.
- Ende-zu-Ende prüfen, dass eine Teilretoure mit zwei Lieferanten je Position korrekt geroutet wird, eine Reklamation ohne Warenrücksendung möglich ist und fehlende Zuordnungen sichtbar zur Klärung bleiben.
- Bei verlorener Antwort nach Annahme, parallelen Änderungen und wiederholten Befehlen müssen alle Edges denselben bestätigten Fallstand sehen. Wareneingang, Bestandsfreigabe und Gutschrift dürfen je Geschäftsvorgang nur einmal gebucht werden.

### Schnittstellen und Einrichtung

- B2B erfasst bestätigte Liefersegmente per `POST /v1/orders/{orderId}/return-deliveries`. Jede Position hat eine stabile Lieferpositions-ID und optional eine geordnete Liste aus Lieferanten-Tenant-ID und Beschaffungspositionsreferenz. Eine Lieferung kann dieselbe Bestellposition auf mehrere Segmente aufteilen. Ohne Lieferdaten muss B2B die Position zuerst nacherfassen.
- B2B und Kleinunternehmer lesen Liefersegmente unter dem jeweiligen Bestellpräfix und erfassen Fälle per `POST …/{orderId}/returns`. B2B nutzt HMAC, Kleinunternehmer ihr Customer-JWT mit `X-Client-Version` und `X-Client-Platform`. Fallabfragen liefern die rollenspezifische Sicht. Schreibbefehle an einen Fall enthalten `command_id`, `line_id` und `version`. HMAC-Clients verwenden für HTTP-Wiederholungen zusätzlich einen stabilen, pfadbezogenen `X-Idempotency-Key`.
- `RETURNS_SUPPLIER_EDGE` ist ein Cloudflare-Service-Binding zum Lieferanten-Worker. Der Empfänger speichert `POST /v1/handoffs` unter der übermittelten `handoff_id` dauerhaft und antwortet mit `{ "handoff_id": "…", "accepted": true }`. Als Referenz dient der private Worker-Entrypoint `ReturnsSupplierInbox` mit Migration `0024_supplier_return_handoffs.sql`. Die Betreiber konfigurieren das Binding auf den tatsächlichen Lieferanten-Worker oder dessen Gateway. Bei Gateway-Ausfall oder fehlendem Binding meldet B2B `503`. Die offene Aufgabe kann mit derselben Befehls-ID erneut angestoßen werden.
- Die Referenz-Inbox listet Annahmen über `GET /v1/suppliers/return-inbox`. Lieferanten lesen und bearbeiten ihre Positionen beim führenden B2B-Edge unter `/v1/suppliers/{ownerTenantId}/orders/{orderId}/returns/{caseId}`. Sie prüfen vor der Bearbeitung, ob ihre Position dort bereits abrufbar ist. Nur der aktuelle Empfänger kann weiterleiten. Jede bereits zugewiesene Lieferantenstufe führt ihre eigene Entscheidung, Warenbearbeitung und Abrechnung.
- `receive` erfasst den Wareneingang zur genehmigten Rücksendemenge. `inspect` bucht die freigegebene Teilmenge für B2B genau einmal in das genehmigte Lager. Für verderbliche Ware wird ein gültiges MHD benötigt. Ein Lieferant bestätigt seine eigene Bestandsbuchung mit `stock_ref`. Weitergereichte Ware bleibt am Durchgangslager gesperrt. Die Summe der Freigaben über alle Stufen ist auf die Fallmenge begrenzt. `settle` erfasst je Geschäftsbeziehung einen bereits ausgestellten Gutschrift- oder Ersatzbeleg mit `document_ref` und stabiler `booking_ref`. Die Ausstellung erfolgt im jeweiligen ERP oder Buchhaltungssystem.
- Der verbindliche Fallstand und die Befehlsresultate liegen in `ReturnsDO` pro Bestellung. Die Inbox des Lieferanten liegt in dessen D1. Das Wiederherstellungsverfahren für Fälle muss bei der Einrichtung den Durable-Object-Speicher einbeziehen. Die bestehenden D1-Exporte decken die Inbox ab.

## Orchestration Layer

Jeder Modul-Eintrag oben trägt ein `path`-Feld, das auf eine eigene
Orchestration-Datei zeigt. Diese Dateien folgen [`_template.md`](orchestration/_template.md)
und enthalten Goal/Non-Goals/Vibe/Error-Paths/Backwards-Compat/Test-Strategy pro Modul.

Querschnittsregeln liegen in der gleichen Schicht:

| Datei                                                                | Zweck                                              |
|----------------------------------------------------------------------|----------------------------------------------------|
| [`README`](orchestration/README.md)                                  | Aufbau, Lifecycle, Goldene Regeln                  |
| [`_vibecoding.md`](orchestration/_vibecoding.md)                     | wie AI-Agents Module bauen                         |
| [`_errors.md`](orchestration/_errors.md)                             | zentraler Fehlercode-Katalog (`GH-DOMAIN-NNN`)     |
| [`_self-optimization.md`](orchestration/_self-optimization.md)       | wie der Plan zur Laufzeit lernt (Learnings + PRs)  |
| [`_backwards-compat.md`](orchestration/_backwards-compat.md)         | Versions- und Kompatibilitätsregeln                |
| [`_template.md`](orchestration/_template.md)                         | Vorlage für Modul-Files                            |

`learnings/<module>.log.md`-Dateien werden **zur Laufzeit** vom Coding-Agent
angelegt und sind append-only. Daraus entstehen Plan-Revisions — siehe
`_self-optimization.md` für das Feedback-Protokoll.

### Status der Orchestration-Files

- **6 Meta-Files vollständig** (README, vibecoding, errors, self-optimization, backwards-compat, template)
- **25 Module `specified`** (15 Core + 10 Hardening) — alle Build-blockierenden OQs entschieden, jeder Modul-File trägt Decisions + Reasons in den ehemals offenen Punkten
- **0 Module `stub`** — Plan ist autopilot-ready inkl. Hardening-Pass
- Status-Übergang `specified → in-flight → shipped` passiert während des Autopilot-Builds

### Per-Modul-Agent-Input (Vertrag)

Wenn der Autopilot Modul `<MID>` baut, bekommt er als Eingabe **nur**:

1. den Modul-Knoten in `build-plan.json`
2. das durch `path` referenzierte Modul-File
3. `_vibecoding.md`, `_errors.md`, `_backwards-compat.md`
4. `cross_cutting` + `stack_decisions` aus diesem Build-Plan

Mehr nicht. Kein Cross-Modul-Code-Reading. Wenn ein Modul Information aus einem
anderen braucht, ist das ein Spec-Bug — hochziehen in `cross_cutting` oder
explizite `inputs_required` im Modul-File.

