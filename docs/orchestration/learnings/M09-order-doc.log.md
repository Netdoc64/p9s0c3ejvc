# M09 — Learnings

### What happened
Zod-Schema `OrderDocSchema` (meta/customer/lines/totals/state/plan/issues/audit/gates_log/external_refs), D1-Tabellen `orders` + `order_lines`, `repos/orders.ts` mit `create`/`findById`/`update` (etag-CAS) /`list`. Canonicalize-Helper für deterministisches etag = sha256(canonical(doc)).

### Decisions
1. **Hybrid-Storage**: Header (state, total, customer_id, etag) als Spalten für Filter/Sort; lines normalisiert; plan/audit/gates_log/issues/state_history/totals/external_refs als JSON-Spalten. Spec-konform.
2. **etag = sha256(canonical-JSON)** — keys sortiert, keine Whitespaces.
3. **`update` macht DELETE+INSERT für lines** statt Diff. Einfacher, atomic in D1-Tx, lines selten viele.
4. **`canTransition` als pure** in `state-machine.ts`, ALLOWED_TRANSITIONS-Map als Single-Source-of-Truth.

### Tests
- bestehende Tests verifizieren die Repo via M11-Routes-Tests indirekt; eigene Round-Trip-Tests sind Plan-Revision-Kandidat.
