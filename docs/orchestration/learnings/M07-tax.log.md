# M07 — Learnings (append-only)

### What happened
Pure tax engine + DB-Resolver, tax_rules-Tabelle mit Match-Felder + priority + match_cross_border + valid_from/to. Initial-Regelset (DE/NL Standard+Reduced, EU-B2B-Reverse-Charge, CH-Export, SKU-Zero).

### Decisions
1. **`priority`-Feld** als Tiebreaker zur Specificity. Niedriger = höher. SKU-zero (10) > export (20) > reverse_charge (50) > Country-Default (100).
2. **`match_cross_border`** als zusätzliches Match-Feld. Verhindert dass `eu_b2b_reverse_charge` bei DE→DE B2B greift. Plan-Revision-Kandidat: erweiterung um Country-Listen wenn weitere EU-Länder nicht 1:1 abgedeckt sind.
3. **VIES `unknown` → wie B2C** (Plan-Decision aus M07-Spec) mit `warning: "vies_unknown"` im Output.
4. **Globale Regeln (`tenant_id IS NULL`)** + Tenant-Overrides (`tenant_id = ?`). Resolver zieht beides via OR-Query.

### Tests
- 7 DB-Snapshot-Tests + 1 ambiguity pure-test
