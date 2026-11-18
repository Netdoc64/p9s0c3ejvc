---
module_id: M07_tax
status: shipped
version: 1.0
last_updated: 2026-04-29
phase: P2_domain
---

# M07 — Tax Engine

## Goal

Pure Funktion `(tenant_country, customer_country, vat_id_status, b2b_b2c, sku_tax_class, on_date)`
→ `{scheme, rate_pct, rule_id, decision_reason}`. Tabellengetrieben, versionsiert.

## Non-Goals

- Kein OSS-Reporting in v1 (Datenfeld ja, Reporting später)
- Keine länderspezifischen Sondervorschriften (z.B. Norwegens Reverse-Charge auf
  bestimmte Waren) — über Open Questions ansprechen, nicht voraus-bauen

## Success Criteria

Wie Build-Plan `M07_tax.acceptance[]`. Zusätzlich:

- Engine ist deterministisch — Snapshot-Tests
- Versionierte Regeln: `tax_rules.valid_from`, `valid_to`
- `decision_reason` enthält Regel-Kürzel (z.B. „§13b UStG / Art. 196 MwStSysRL")

## Execution Intent (Vibe)

- Niemals Steuerlogik in Code-Branches verstecken — alles in Daten.
- Engine matched **alle** Regeln, prüft `valid_from/to`, wählt die spezifischste
  (wenn mehrere matchen).
- Bei Mehrdeutigkeit: explizit Fehler `GH-TAX-001`, kein „der erste Treffer".

## Inputs Required

- M04 (Customer mit `country`, `vat_status`, `b2b_b2c`)
- M05 (SKU mit `tax_class`)
- Antwort auf Open Questions

## Deliverables

```
migrations/00XX_tax.sql                tax_rules
src/engines/tax.ts                     pure
src/engines/tax.test.ts                15+ Szenarien
src/services/tax-resolver.ts           lädt Regeln, ruft Engine
src/repos/tax-rules.ts
seeds/tax-rules-eu.ts                  Initial-Regelset
```

## Happy Path

1. Caller (Pricing-Resolver, M06) ruft `tax.resolve({tenant_country, customer_country, vat_id_status, b2b_b2c, sku_tax_class, on_date})`.
2. Resolver lädt aktive Regeln: `SELECT FROM tax_rules WHERE valid_from <= on_date AND (valid_to IS NULL OR valid_to > on_date)`.
3. Engine (pure): filtert die Regeln über deklarative Match-Felder. Eine Regel matcht, wenn jedes ihrer Match-Felder entweder `null` (= Wildcard) oder gleich der Eingabe ist.
4. Match-Resultate sortieren nach Spezifität = Anzahl gesetzter (= nicht-null) Match-Felder, absteigend.
5. Genau 0 Matches → `throw GH-TAX-001` mit Detail (welche Eingaben, welche Regeln verglichen).
6. Genau 1 Top-Match → return `{scheme, rate_pct, rule_id, decision_reason: rule.reason_template}`.
7. Mehrere Top-Matches mit gleicher Spezifität → `throw GH-TAX-001` mit Auflistung aller Top-Match-`rule_id`s (Daten-Bug, Tenant-Setup-Aufgabe).
8. Wenn `vat_id_status === "unknown"`: Engine behandelt wie ohne VAT-ID (B2C-Pfad), aber Output enthält `warning: "vies_unknown"` zusätzlich zum decision_reason.

## Error Paths

| Symptom                       | Code         | Recovery |
|-------------------------------|--------------|----------|
| Keine Regel matcht            | `GH-TAX-001` | 422; Hinweis welche Eingaben |
| Mehrdeutige Regeln            | `GH-TAX-001` | 422; alle matchenden auflisten — Tenant-Setup-Bug |

## Fallbacks

- VIES `unknown` → Engine behandelt wie ohne VAT-ID (B2C-Fall) MIT Warning im
  Output. Bestellung kann durchlaufen, wenn Tenant `allow_unknown_vat=true`.

## Backwards-Compat Implications

- `scheme`-Enum: `standard`, `reduced`, `zero`, `reverse_charge_eu`, `export`,
  `oss_b2c`, `kleinunternehmer`, … additiv erweiterbar.
- Regel-IDs (`tax_eu_b2b_reverse_charge`, …) sind permanent — sie tauchen in
  historischen Order-Documents auf.

## Open Questions

- [x] ~~Welche Steuerklassen für Pilot?~~ → **`standard`, `reduced`, `zero`** vom Start
  (2026-04-28). Reason: minimaler Mehraufwand (Enum + Mapping pro Land), erspart
  späte Schema-Migration.
- [x] ~~OSS aktivieren?~~ → **Nein für v1** (2026-04-28). Reason: Pilot ist B2B-only.
  OSS-`scheme` bleibt im Enum reserviert, Aktivierung via Plan-Revision wenn
  B2C-Kanäle relevant.
- [x] ~~Schweiz-Regelset?~~ → **Ja von Tag 1, CH-MwSt 8.1% (Stand 2024+)**
  (2026-04-28). Reason: Test-Kunde CH ist im Pilot-Seed; Acceptance-Test
  „Tenant DE → Kunde CH B2B → export, 0%" verlangt CH-Logik bereits.

## Observability

- Tax-Resolver-Häufigkeit pro Scheme
- Anzahl `unknown`-VAT-Fallbacks (Indikator für VIES-Probleme)

## Test Strategy

- 15+ Szenario-Snapshots
- Property-Test: VAT-ID gültig + B2B + EU-EU → immer reverse_charge
- Versionierungs-Test: dieselbe Regel zu unterschiedlichen Daten → richtige Version

## Learnings

→ `learnings/M07-tax.log.md`

## Plan Revisions Originating Here

(initial leer)
