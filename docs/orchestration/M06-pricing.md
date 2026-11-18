---
module_id: M06_pricing
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M06 — Pricing Engine

## Goal

Eine deterministische Funktion, die für ein Tupel
`(tenant, customer, sku, qty, date)` den anwendbaren Preis liefert — mit
nachvollziehbarer Auflösungsreihenfolge und einem strukturierten Breakdown,
der direkt ins Order-Document passt (`lines[].pricing`).

## Non-Goals

- **Kein Caching** in der Engine selbst. Cache liegt im Service-Layer
  (`pricing-resolver`), Engine ist pur.
- **Keine Aktionen / Promotions** in v1 (siehe Open Questions). Nur Listenpreis,
  Preisgruppe, Mengenstaffel, Sonderpreis.
- **Keine FX-Konversion** (deferred D05).
- **Keine Currency-Mischung in einer Order** (Tenant-Currency = Order-Currency).

## Success Criteria

- Engine ist eine pure Funktion: gleiche Inputs ⇒ gleiche Outputs (Snapshot-Test)
- Auflösungsreihenfolge **deterministisch und dokumentiert**:
  `customer_special > customer_group_special > qty_break > list_default`
- Output enthält `decision_reason` mit angewandter Regel-ID
- 20+ Test-Szenarien decken alle Pfade ab
- Engine-Performance: <1ms p99 für Standard-Lookup mit injizierten Daten
- 100% Branch-Coverage in der Engine selbst (Service darf weniger haben)

## Execution Intent (Vibe)

- **Funktional zuerst, Persistenz zuletzt.** Schreib die Engine + Tests zuerst;
  Datenbank-Schema wird erst gegen Ende festgezurrt.
- **Tabellengetrieben statt if-else-Wald.** Regeln laden, Regeln matchen, beste
  wählen — keine hartkodierten Branches.
- **Nichts inferieren, was nicht da ist.** Wenn keine Regel matcht → `GH-PRICE-001`,
  nicht „nimm halt den Listenpreis als Fallback ohne Reason".
- **Cents überall.** `final_price_per_unit_cents: 8075` (= 0.8075 EUR), niemals Floats.
- **Reasons sind Pflicht, nicht Decoration.** Jede angewandte Regel kommt mit ihrer
  ID in den Breakdown, jede verworfene Alternative ebenfalls (`rejected_because`).

## Inputs Required

- Build-Plan-Knoten: `M06_pricing`
- Abhängigkeiten: M04 (Customer mit `price_group`), M05 (Product mit Verpackung)
- Cross-Cutting: `money_representation` (Cents-Integer), `id_format`
- Antwort auf Open Questions (siehe unten) — sonst `status: stub` bleibt
- Konkretes Engine-Interface — vorgeschlagen:

```ts
type PricingInput = {
  tenant_id: string;
  customer: Pick<Customer, "id" | "price_group" | "currency">;
  sku: Pick<Product, "id" | "tax_class">;
  qty_units: number;            // bereits in kleinster Einheit (Stiel, nicht Karton)
  on_date: string;              // ISO-UTC
  context: {                    // injizierte Daten — Engine fetched nichts
    customer_special?: SpecialPrice;
    group_special?: SpecialPrice;
    qty_breaks: QtyBreak[];
    list_price?: ListPrice;
    list_id?: string;
  };
};

type PricingOutput = {
  list_id: string;
  base_price_per_unit_cents: number;
  discounts_applied: { rule_id: string; type: "percent"|"abs"; value: number; reason: string }[];
  final_price_per_unit_cents: number;
  line_subtotal_net_cents: number;
  decision_reason: string;
  rejected_alternatives: { rule_id: string; reason: string }[];
};
```

## Deliverables (Outputs)

```
src/engines/pricing.ts                Pure Engine
src/engines/pricing.test.ts           20+ Szenarien (Vitest)
src/services/pricing-resolver.ts      Lädt Daten, ruft Engine
src/services/pricing-resolver.test.ts
src/repos/pricing.ts                  D1-Zugriff (tenant-scoped)
migrations/00XX_pricing.sql           price_lists, price_list_items,
                                      customer_special_prices, qty_breaks
src/routes/pricing.ts                 POST /pricing/quote
```

## Happy Path

1. Resolver lädt für `(customer, sku, date)`:
   - `customer_special` (falls existiert und in Gültigkeitsfenster)
   - `group_special` (über `customer.price_group`)
   - alle `qty_breaks` für die SKU (oder Kategorie)
   - `list_price` aus aktiver `price_list` für die `price_group`
2. Resolver ruft Engine mit injiziertem Context.
3. Engine geht Regeln in Reihenfolge durch, wählt erste matchende:
   - `customer_special` matcht ⇒ Basispreis ist das, weiter zu `qty_breaks` Bonus
   - sonst `group_special` matcht ⇒ analog
   - sonst `list_price` ⇒ Basispreis = `list_price.price`
4. Über Basispreis: passender `qty_break` (höchste Schwelle ≤ qty) wird angewandt.
5. `final_price_per_unit_cents = round_half_to_even(base * (1 - discount_pct/100))`.
6. Output mit `decision_reason` zusammenbauen.

## Error Paths

| Symptom                                          | Code             | Recovery |
|--------------------------------------------------|------------------|----------|
| Keine Liste/Special/Default für (customer, sku)  | `GH-PRICE-001`   | 422; OrderDoc landet in `issues.blocking[]` |
| Liste vorhanden, aber `valid_to < on_date`       | `GH-PRICE-002`   | 422; Hinweis welche Liste, welcher Zeitraum |
| D1 nicht erreichbar beim Resolver                | `GH-INFRA-001`   | 503, exponential retry |
| Customer hat `price_group` die nicht existiert   | `GH-INPUT-001`   | 400; Datenintegritätsfehler — Tenant-Setup-Bug |

## Fallbacks

- **Kein konfigurierter Listenpreis aber Sonderpreis vorhanden:** Sonderpreis
  ist Basispreis. Output mit `decision_reason: "Kein Listenpreis, Sonderpreis als Basis"`.
- **VIES-Status `unknown` (siehe Tax-Engine):** beeinflusst **nicht** den Preis,
  nur die Steuer.
- **Mehrere `qty_breaks` matchen aufgrund schlechter Konfiguration:** strikt die
  mit der **höchsten** Schwelle, deterministisch. Andere als `rejected_alternatives`.

## Backwards-Compat Implications

- **`PricingOutput`-Shape** wird vom Order-Document referenziert (`lines[].pricing`).
  Additiv erweiterbar, niemals Felder umbenennen.
- **Regel-IDs** (`qty_break_100plus`, `customer_special_floraly_rose60`) sind
  langlebig — sie tauchen in historischen Order-Documents auf. Nicht
  wiederverwenden, nicht umbenennen.
- **Auflösungsreihenfolge** ist Vertrag, nicht Implementation-Detail. Ändern =
  Major-Bump.

## Open Questions

- [x] ~~Mengenstaffel kumulativ vs pro Line?~~ → **Pro Line** (2026-04-28).
  Reason: Branchenpraxis Blumen-Grosshandel. Schema-Feld `qty_break_scope:
  "line"|"order"` mit Default `"line"` ist drin — späte Erweiterung
  zu order-scoped ist additiv.
- [x] ~~Aktionen vs Mengenstaffel?~~ → **Beide laufen, deterministische
  Reihenfolge** (2026-04-28).
  Engine-Datenmodell hat Regel-Typ-Feld; Reihenfolge:
  `customer_special > group_special > promo_action > qty_break > list_default`.
  Konkrete Promo-Action-Implementation kommt später (deferred), aber Slot
  existiert jetzt.
- [x] ~~Rounding?~~ → **`round_half_to_even` (Banker's Rounding)** (2026-04-28).
  In `cross_cutting.money_representation.rounding` aufgenommen.
- [x] ~~Listenpreis-Einheit?~~ → **Listenpreis IMMER pro Basis-Einheit (`qty_unit`)**,
  bei Blumen also pro Stiel (2026-04-28). Resolver konvertiert
  Verpackung → Basis vor Engine-Aufruf.

→ Alle 4 OQs resolved; Modul wechselt mit nächstem Re-Spec von `stub` →
`specified`.

## Observability

- Log-Felder: `tenant_id`, `customer_id`, `sku_id`, `qty_units`, `applied_rule_id`,
  `final_price_per_unit_cents`
- Counter: `pricing.resolution.no_match` — alarmiert wenn >0 in Prod (Tenant-Setup-Lücke)
- Histogram: `pricing.resolver.duration_ms`

## Test Strategy

- **Unit (Engine):** Snapshot-Tests für 20+ Szenarien
  - Nur Liste — Basispreis
  - Liste + Mengenstaffel über Schwelle
  - Liste + Mengenstaffel unter Schwelle
  - Customer-Special + Mengenstaffel
  - Group-Special + Mengenstaffel
  - Customer-Special > Group-Special (Reihenfolge)
  - Mehrere Qty-Breaks → höchster matchender
  - Liste abgelaufen → Fehler
  - Keine Regel matcht → Fehler
  - Edge: qty=0, qty=1 mit Min-Order
  - Cents-Rounding-Edge-Cases (0.005 → ?)
  - Verworfene Alternativen tauchen im Output
  - …
- **Integration (Service):** D1 mit echtem Tenant-Setup, gleiche 20+ Szenarien
  durchgepushed
- **Property-Test (optional):** generiere zufällige (qty, base, discount_pct),
  invariant `final ≤ base` und `final = base − discount`
- **Cross-Tenant-Test:** Tenant-A-Customer mit Tenant-B-SKU → `GH-TENANT-001`

## Learnings (Runtime-Append)

→ `learnings/M06-pricing.log.md`

## Plan Revisions Originating Here

(initial leer)
