# Order Document — JSON-Orchestrator-Format

## Grundidee

Eine Bestellung ist **ein einziges JSON-Dokument**, das über ihre gesamte Lebenszeit
existiert und schrittweise angereichert wird. Es enthält:

1. **Was wurde gewollt** (Input / Intent)
2. **Was wurde daraus** (Resolution: aufgelöste SKUs, Preise, Steuern)
3. **Welche Entscheidungen gefällt wurden — und warum** (Decision Log)
4. **Welcher Zustand jetzt gilt** (State Machine)
5. **Was als Nächstes passieren muss** (Plan / Steps)
6. **Welche externen Effekte schon laufen** (Refs auf Buchhaltung, Lager, Payment)

Der Orchestrator selbst ist **stateless**: er bekommt das Dokument, berechnet den
nächsten erlaubten Step, mutiert das Dokument, persistiert. Jede Mutation ist
append-only im `state.history` und `plan.executed_steps` — Rekonstruktion zu jedem
Zeitpunkt möglich.

> **Goldene Regel:** Jede automatische Entscheidung trägt ein `decision_reason`-Feld.
> Wenn der Orchestrator etwas tut, was ein Mensch in 6 Monaten nachvollziehen will,
> steht der Grund im Dokument — nicht in einem Log irgendwo.

## Top-Level-Struktur

```
order-document
├── meta              identität, schema, idempotency
├── source            woher kam der request (channel, client)
├── actor             wer hat ausgelöst (mensch, agent, system)
├── customer_snapshot kunde zum bestellzeitpunkt (eingefroren)
├── lines[]           positionen, jeweils mit input/resolution/pricing/tax/stock
├── totals            summen, währung, fx-snapshot
├── gates[]           validierungs-checks (credit, min-order, vat, stock, …)
├── state             current + history
├── plan              next_steps[] + executed_steps[]
├── external_refs     ids in buchhaltung_eu, lager, payment-provider
├── issues            blocking[] + warnings[]
└── audit             ai_decisions[], fallback-info
```

## Vollbeispiel (Pilot-Tenant, B2B EU-Reverse-Charge)

```json
{
  "meta": {
    "schema_version": "1.0",
    "doc_type": "order",
    "id": "ord_01HTXYZABC123",
    "tenant_id": "t_pilot",
    "idempotency_key": "client-uuid-7f3e8a1b",
    "created_at": "2026-04-28T10:15:00.000Z",
    "updated_at": "2026-04-28T10:15:42.117Z",
    "etag": "sha256:9c2f...",
    "locale": "de-DE"
  },

  "source": {
    "channel": "mcp",
    "client_id": "claude-desktop",
    "client_version": "1.4.2",
    "request_id": "req_8a91fc",
    "ip_hash": "sha256:..."
  },

  "actor": {
    "type": "agent_ai_mcp",
    "id": "mcp_session_abc123",
    "on_behalf_of_customer": "cust_floraly_42",
    "auth": {
      "method": "oauth_mcp",
      "token_hash": "sha256:...",
      "scopes": ["order.create", "order.read"],
      "issued_at": "2026-04-28T09:00:00.000Z"
    },
    "decision_reason": "MCP-Token gültig, Scope deckt order.create"
  },

  "customer_snapshot": {
    "id": "cust_floraly_42",
    "name": "Floraly GmbH",
    "billing_country": "DE",
    "shipping_country": "DE",
    "vat_id": "DE123456789",
    "vat_id_validation": {
      "status": "valid",
      "checked_at": "2026-04-28T08:00:00.000Z",
      "source": "vies",
      "cache_age_hours": 2.25,
      "decision_reason": "VIES-Cache <24h frisch, kein Re-Check nötig"
    },
    "currency": "EUR",
    "price_group": "wholesale_a",
    "payment_terms_days": 30,
    "credit": {
      "limit": 10000.00,
      "used_at_decision": 3200.00,
      "available_at_decision": 6800.00,
      "decision_reason": "Snapshot zum Bestellzeitpunkt — spätere Bewegungen ändern dieses Feld nicht"
    },
    "blocked": false
  },

  "lines": [
    {
      "line_id": "ln_1",
      "input": {
        "raw_text": "10 Karton rote Rosen 60cm",
        "qty": 10,
        "unit": "carton",
        "source": "mcp_tool_call"
      },
      "resolution": {
        "sku_id": "sku_rose_naomi_red_60",
        "sku_name": "Rose Naomi rot 60cm",
        "match_method": "ai_semantic_search",
        "match_confidence": 0.94,
        "alternatives_considered": [
          { "sku_id": "sku_rose_red_50", "confidence": 0.71, "rejected_because": "Länge 50cm passt nicht zu '60cm'" },
          { "sku_id": "sku_rose_red_70", "confidence": 0.68, "rejected_because": "Länge 70cm passt nicht" }
        ],
        "decision_reason": "Höchste semantische Übereinstimmung, 60cm explizit, Sorte 'Naomi' häufigste rote Rose dieser Länge im Sortiment",
        "human_confirmation_required": true,
        "human_confirmation_status": "pending"
      },
      "packaging": {
        "requested_unit": "carton",
        "carton_size": 20,
        "min_order_unit": "carton",
        "qty_units_final": 200,
        "round_up_applied": false,
        "decision_reason": "Bestellt in Karton, Karton ist zulässige Bestelleinheit, keine Aufrundung"
      },
      "pricing": {
        "list_id": "pl_wholesale_a_2026_q2",
        "list_valid_from": "2026-04-01T00:00:00.000Z",
        "list_valid_to": "2026-06-30T23:59:59.999Z",
        "base_price_per_unit": 0.85,
        "currency": "EUR",
        "discounts_applied": [
          {
            "rule_id": "qty_break_100plus",
            "type": "percent",
            "value": 5.0,
            "decision_reason": "Mengenstaffel: 200 Stiele ≥ Schwelle 100, automatisch angewendet"
          }
        ],
        "final_price_per_unit": 0.8075,
        "line_subtotal_net": 161.50,
        "decision_reason": "price_group=wholesale_a → Liste pl_wholesale_a_2026_q2; Mengenstaffel überschritten; Kunde hat keinen Sonderpreis für diese SKU"
      },
      "tax": {
        "scheme": "reverse_charge_eu",
        "rate_pct": 0,
        "amount": 0,
        "applied_rule_id": "tax_eu_b2b_reverse_charge",
        "decision_reason": "Tenant-Land NL, Kunden-Land DE, gültige VAT-ID verifiziert, B2B → §13b UStG / Art. 196 MwStSysRL"
      },
      "stock": {
        "warehouse_id": "wh_aalsmeer",
        "available_at_decision": 850,
        "reserved_units": 200,
        "reservation_id": "res_xyz789",
        "reservation_expires_at": "2026-04-28T10:45:00.000Z",
        "backorder_used": false,
        "decision_reason": "Primäres Lager Aalsmeer voll verfügbar, keine Aufteilung über Lager nötig"
      }
    }
  ],

  "totals": {
    "subtotal_net": 161.50,
    "discount_total": 8.50,
    "tax_total": 0.00,
    "shipping": 0.00,
    "grand_total": 161.50,
    "currency": "EUR",
    "fx": null,
    "decision_reason": "Tenant- und Kunden-Währung beide EUR, kein FX-Snapshot nötig"
  },

  "gates": [
    {
      "id": "min_order_value",
      "result": "pass",
      "evaluated": { "subtotal": 161.50, "threshold": 50.00 },
      "reason": "Über Mindestbestellwert von 50 EUR"
    },
    {
      "id": "credit_check",
      "result": "pass",
      "evaluated": { "grand_total": 161.50, "credit_available": 6800.00 },
      "reason": "Kreditrahmen ausreichend (Auslastung nach Buchung 49.6%)"
    },
    {
      "id": "vat_id_check",
      "result": "pass",
      "evaluated": { "vat_id": "DE123456789", "vies_status": "valid" },
      "reason": "VIES gültig und frisch im Cache"
    },
    {
      "id": "stock_check",
      "result": "pass",
      "evaluated": { "lines_total": 1, "lines_available": 1 },
      "reason": "Alle Positionen reserviert"
    },
    {
      "id": "customer_blocked",
      "result": "pass",
      "evaluated": { "blocked": false },
      "reason": "Kunde nicht gesperrt"
    }
  ],

  "state": {
    "current": "awaiting_confirmation",
    "history": [
      { "to": "draft",                "at": "2026-04-28T10:15:00.000Z", "by": "actor",  "reason": "Bestellung initiiert via MCP" },
      { "to": "resolving",            "at": "2026-04-28T10:15:05.000Z", "by": "system", "reason": "SKU-Resolution + Pricing gestartet" },
      { "to": "validated",            "at": "2026-04-28T10:15:12.000Z", "by": "system", "reason": "Alle Gates passed" },
      { "to": "awaiting_confirmation","at": "2026-04-28T10:15:42.000Z", "by": "system", "reason": "AI-Resolution unter 1.0 Konfidenz → Kundenbestätigung erforderlich" }
    ],
    "allowed_transitions": ["confirmed", "cancelled", "modified"]
  },

  "plan": {
    "next_steps": [
      {
        "id": "step_confirm",
        "type": "user_interaction",
        "blocking": true,
        "channel": "mcp",
        "prompt": "Bitte 10 Karton (200 Stiele) Rose Naomi rot 60cm zu 0,8075 €/Stiel = 161,50 € netto bestätigen.",
        "reason": "MCP-Flow: vor Order-Commit immer Preis + Bestätigung anzeigen"
      },
      {
        "id": "step_invoice",
        "type": "external_call",
        "target": "buchhaltung_eu",
        "after": "confirmed",
        "idempotency_key": "ord_01HTXYZABC123:invoice",
        "reason": "Rechnung erzeugen, Nummernkreis Tenant t_pilot"
      },
      {
        "id": "step_warehouse",
        "type": "queue_message",
        "target": "queue_warehouse_aalsmeer",
        "after": "confirmed",
        "reason": "Kommissionierung anstossen"
      },
      {
        "id": "step_notify",
        "type": "notification",
        "target": "customer_email",
        "after": "confirmed",
        "reason": "Bestellbestätigung an Kunde"
      },
      {
        "id": "step_webhook",
        "type": "webhook",
        "event": "order.confirmed",
        "after": "confirmed",
        "reason": "Tenant-konfigurierte Webhooks (Shop-Sync, BI, etc.)"
      }
    ],
    "executed_steps": [
      {
        "id": "step_resolve",
        "type": "internal",
        "started_at": "2026-04-28T10:15:05.000Z",
        "finished_at": "2026-04-28T10:15:11.500Z",
        "result": "ok",
        "output_summary": "1 line resolved, confidence 0.94"
      },
      {
        "id": "step_reserve_stock",
        "type": "internal",
        "started_at": "2026-04-28T10:15:11.600Z",
        "finished_at": "2026-04-28T10:15:11.900Z",
        "result": "ok",
        "output_summary": "200 units reserved at wh_aalsmeer until 10:45"
      }
    ]
  },

  "external_refs": {
    "invoice_id": null,
    "invoice_number": null,
    "shipment_id": null,
    "payment_id": null,
    "buchhaltung_eu_doc_id": null
  },

  "issues": {
    "blocking": [],
    "warnings": [
      {
        "code": "ai_resolution_below_threshold",
        "scope": "lines[0]",
        "reason": "Konfidenz 0.94 < 0.98 → Kundenbestätigung verlangt"
      },
      {
        "code": "stock_low_after_reservation",
        "scope": "sku_rose_naomi_red_60",
        "reason": "Bestand fällt nach Reservierung auf 650, unter Reorder-Schwelle 1000"
      }
    ]
  },

  "audit": {
    "ai_decisions": [
      {
        "step": "sku_resolution",
        "line_id": "ln_1",
        "model": "claude-opus-4-7",
        "input_hash": "sha256:abc123...",
        "confidence": 0.94,
        "fallback_used": false,
        "human_review_required": true
      }
    ],
    "rule_versions": {
      "tax_engine": "2026.04",
      "pricing_engine": "1.7.0",
      "stock_engine": "2.1.0"
    }
  }
}
```

## Felder — warum sie da sind

### `meta`
- **`schema_version`** — Migrationen laufen, alte Dokumente müssen lesbar bleiben.
- **`tenant_id`** — Mandanten-Isolation auf Dokumentebene, jede Query muss filtern.
- **`idempotency_key`** — Client liefert. Gleicher Key + gleicher Tenant → derselbe `id`.
- **`etag`** — Optimistic Locking. Concurrent Writer prallt ab statt zu überschreiben.
- **`locale`** — Bestimmt Formate für PDF/Email, nicht für Logik.

### `source` & `actor`
Getrennt, weil **Channel ≠ Akteur**: ein menschlicher Mitarbeiter kann via Web-Portal
für einen Kunden bestellen (`channel=web`, `actor.type=employee`,
`on_behalf_of_customer=...`). Auth-Proof gehört zu `actor`, nicht zu `source`.

### `customer_snapshot`
**Snapshot, nicht Referenz.** Wenn der Kunde nächstes Jahr seinen Namen ändert oder
seine VAT-ID wechselt, bleibt die alte Bestellung historisch korrekt. Gleiches Argument
wie bei Pricing.

### `lines[]` mit `input` / `resolution` getrennt
- `input` = was kam rein (raw + parsed)
- `resolution` = was hat das System daraus gemacht

So sieht man bei einem Streit „aber ich wollte 70cm Rosen!" sofort, dass `input.raw_text`
„60cm" sagte. Bei Bestellungen via MCP/WhatsApp/Telefon ist das gold wert.

`alternatives_considered` mit `rejected_because` ist explizit redundant — aber rettet
dich, wenn das KI-Modell nächstes Jahr eine andere Wahl träfe.

### `pricing` mit Listen-ID + Gültigkeitsfenster
Der Snapshot muss reproduzierbar sein. Wenn `pl_wholesale_a_2026_q2` nicht mehr
existiert, beweist das Dokument selbst was galt.

### `tax` mit `applied_rule_id`
Die Steuer-Engine ist ein eigenes Modul mit Regelversion (`audit.rule_versions.tax_engine`).
Ein Auditor kann später sagen „Regel-Version 2026.04 zeigen" und genau diese Logik
nachvollziehen.

### `stock.reservation_expires_at`
**Soft-Reservation mit TTL.** Wenn der Kunde 30min nicht bestätigt, gibt der Stock-DO
die Einheiten frei. Sonst hängen Geister-Reservierungen.

### `gates[]`
Jeder Gate ist deterministisch, einzeln auswertbar, mit Input und Reason. Wenn
`credit_check` fehlschlägt, willst du im Doc sehen: „evaluated: limit=10000, used=10100,
available=-100" — nicht nur „failed".

### `state.allowed_transitions`
Im Dokument selbst, damit der Orchestrator beim Lesen sofort weiss was er darf.
Vermeidet eine separate State-Machine-Definition, die out-of-sync laufen kann.

### `plan.next_steps[]` mit `after`-Bedingungen
Der Orchestrator durchsucht next_steps nach „erste Sache wo `after`-Bedingung erfüllt
und nicht in `executed_steps`". Jeder Step hat eigenen `idempotency_key` für externe
Calls — Retry-sicher.

### `audit.ai_decisions[]`
KI-Aufrufe sind teuer und nicht-deterministisch. Festhalten von Modell + Input-Hash +
Konfidenz erlaubt: (a) Replay, (b) Qualitätsmetriken, (c) Beweis bei Streit
„hat die KI das halluziniert?".

## Lifecycle / Erlaubte States

```
draft
  ↓
resolving                  (SKU-Match, Pricing, Stock-Reserve laufen)
  ↓
validated                  (alle Gates pass)
  ↓
awaiting_confirmation      (nur wenn human_confirmation_required)
  ↓
confirmed                  (Stock-Reservation → fest, Plan startet)
  ↓
invoiced
  ↓
fulfilling                 (Lager hat angenommen)
  ↓
shipped
  ↓
delivered
  ↓
closed                     (paid + delivered)

Nebenpfade:
  any → cancelled           (mit reason; reservierter Stock wird freigegeben)
  any → on_hold             (Credit-Block, Kunde gesperrt, manueller Review)
  validated → modified → resolving   (Kunde ändert Position vor Bestätigung)
  delivered → returned                (Retoure → CreditNote-Sub-Doc)
```

Jeder Übergang ist im `state.history` mit `reason` festgehalten.

## Was bewusst NICHT im Dokument ist

- **Produktstammdaten** (Beschreibungen, Bilder) → nur SKU-ID + Name-Snapshot
- **Volle Customer-Daten** (Adresse-Historie, Kontakte) → nur Snapshot der relevanten Felder
- **Logs / Telemetry** → eigenes System, mit Doc-ID verlinkt
- **PII unverschlüsselt** → IP wird gehasht, Tokens nur als Hash
- **Buchhaltungsdetails** → nur `external_refs.buchhaltung_eu_doc_id`, der Rest liegt drüben

## Resolved (Stand 2026-04-28 — siehe [build-plan.md](build-plan.md))

1. ✅ **Sub-Documents** → **Eigene `doc_type`s** (`credit_note`, `shipment`,
   `return`) mit `parent_order_id`. Order bleibt schmal, Lifecycle entkoppelt.
   (M09)
2. ✅ **Multi-Order-Saga (Teillieferungen)** → eigene `shipment`-Docs mit
   `parent_order_id`. Order trägt nur einen Verweis, kein Array. **Deferred D04**
   für die Implementierung (Saga-Pattern), Schema-Slot bleibt frei.
3. ✅ **Modifikation nach Bestätigung** → mutieren mit etag-basiertem Optimistic
   Lock und Audit-Trail (`state.history` + `audit`). Bei finalen States
   (`shipped`, `paid`) ist Modifikation nur via Gutschrift-Sub-Doc erlaubt
   (`GH-STATE-001`). (M09 + M10)
4. ✅ **Schema-Validierung** → **Zod als Source**, JSON Schema generiert für
   externe Clients und MCP. (M09)
5. ✅ **Storage** → **Hybrid:** header + lines normalisiert in D1-Tabellen für
   Queries; `plan`, `audit`, `gates_log` als drei separate JSON-Spalten (nicht
   ein Blob — verhindert Concurrent-Write-Konflikte). (M09)
6. ✅ **Eventing** → ja, Outbox-Pattern mit CF Queue + Webhook-Delivery,
   per-Topic Major-Versionierung (`order.confirmed.v1`). (M12)

## Visibility-Markierung (G3-Resolution)

Felder im Doc tragen `_visibility: "tenant"|"customer"|"internal"` damit
Renderer je nach Konsument filtern können:

- **`internal`** — nur Operator/Support: `audit.ai_decisions[]`,
  `lines[].resolution.alternatives_considered[].rejected_because`,
  `lines[].pricing.decision_reason` (Engine-Internas)
- **`tenant`** — Tenant-Operator (Grosshändler): + alle Order-Daten,
  Stock-Reservation-Details, Customer-Snapshot
- **`customer`** — Endkunde via Mobile/MCP: + öffentlich erlaubte Felder
  (`state.history` ohne by=system-Reasons, `lines[].pricing.final_price`,
  `totals`, `external_refs`)

Implementiert als Feld-Annotation im Zod-Schema; Renderer-Funktion entfernt
Felder unterhalb des angefragten Visibility-Levels.
