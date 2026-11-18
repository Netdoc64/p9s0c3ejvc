# M06 — Learnings

### What happened
Pure pricing engine (customer_special > qty_break > list), DB-Resolver, REST `/v1/pricing/quote`, banker's rounding für pct-Rabatte.

### Decisions
1. **`customer_group_special` und `promo`** sind nicht in v1. Plan-Revision-Kandidat wenn Tenant-Verträge das brauchen. Reihenfolge im Code so vorbereitet, dass sie additiv eingebaut werden können.
2. **`qty_breaks.sku_id` darf NULL sein** (= gilt für gesamte Liste). Pragmatisch für „Mengenrabatt auf alles".
3. **Determinismus durch pure function** + Snapshot-Test belegt.

### Tests
- 7 Tests grün (list-only, qty_break absolute/percent, customer_special wins, no list_item, deterministic, banker's rounding)

## 2026-11-17 — Preisanfrage: Batch statt Parallelität

Die Preisanfrage war die langsamste Route im Lasttest (p50 268 ms): bis zu sechs D1-Abfragen nacheinander. Erster Versuch `Promise.all` über Einzelabfragen: schneller, aber unter Last liefen **21 % aller Anfragen** in Fehler — auch die Suche, die hier gar nicht beteiligt ist —, weil mehr gleichzeitige Abfragen die Warteschlange der D1 überlaufen ließen. D1 arbeitet je Datenbank nacheinander; Parallelität im Worker macht sie nicht schneller, nur voller. Lösung: `db.batch` (mehrere Abfragen in einem Roundtrip, ein Platz in der Warteschlange). Ergebnis: Preisanfrage p50 174 ms, gesamt 207 statt 154 rps, 0 % Fehler. Der Lasttest sammelt seither je Route ein Beispiel des Fehler-Bodys.
