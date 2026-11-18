# Runbook — Disaster Restore (D1)

**Backup-Quelle:** R2 unter `backups/d1/<YYYY-MM-DD>/<YYYY-MM-DD>-<HH>.jsonl`
**RTO-Ziel:** 4h, **RPO-Ziel:** 1h (täglicher Backup um 02:00 → max 23h Datenverlust v1; Plan-Revision: hourly).

## Vor-Schritte (immer)

1. Incident anrufen, kommunizieren.
2. Schreibzugriff stoppen (Worker auf maintenance mode = Plan-Revision-Kandidat).
3. Backup-Hash verifizieren (`customMetadata.hash`).

## Restore in eine fresh D1-Instance

```bash
# 1. Neue D1-DB anlegen (Region wie Production)
wrangler d1 create grosshandel-restore --location weur

# 2. Schema einspielen (die DB steht noch in keiner wrangler.toml → je Datei)
for f in migrations/*.sql; do wrangler d1 execute grosshandel-restore --remote --yes --file "$f"; done

# 3. Stand wählen: Präfix backups/d1/<datum>/<datum>-<stunde> (stündlich, 30 Tage)
#    und zurückspielen. Das Skript lädt Manifest + Tabellen aus R2, prüft JEDEN
#    Hash gegen das Manifest, BEVOR es schreibt, spielt je Tabelle eine SQL-Datei
#    ein und zählt am Ende nach.
pnpm tsx scripts/restore-d1.ts --bucket grosshandel-assets-prod   --prefix backups/d1/2026-11-17/2026-11-17-21 --target grosshandel-restore --remote
```

## DO-Bestand nach D1-Restore neu aufbauen

**Nicht im D1-Backup: der Bestand in den Durable Objects** (StockDO). Bei einem
reinen D1-Schaden bleiben die DOs intakt und nichts ist zu tun. Gehen sie
verloren (oder wird D1 auf einen älteren Stand zurückgespielt und die DOs
weichen ab), wird `available` je tenant/warehouse/sku aus `stock_movements`
neu berechnet (Summe `qty_delta`; reserve/release/auto_release tragen 0).

1. **Plan ansehen** (nur lesend, nichts wird geschrieben). Standard ist die
   lokale D1; `--remote` liest die D1 per SELECT:

   ```bash
   pnpm tsx scripts/rebuild-stock.ts --db grosshandel-restore --remote --out plan.json
   ```

   Die Ausgabe nennt je DO-Schlüssel `available`, Anzahl Bewegungen und die
   Summe aktiver Chargen (`stock_batches`). Ein Hinweis „Chargen weichen ab"
   oder „negativer Bestand" vor dem Einspielen klären — der Zielwert kommt
   immer aus den Bewegungen.
2. **Einspielen:** `rebuildStockDO(env, targets, { force })` aus
   `src/services/stock-rebuild.ts` ruft je Schlüssel die DO-Aktion `/rebuild`
   per Stub. Die Aktion ist **nicht über HTTP-Routen erreichbar** (weder
   `/v1/…` noch `index.ts`), nur aus dem Worker-Code. Ohne `force` bleibt ein
   vorhandener, abweichender DO-Zustand unangetastet (Ergebnis `exists`);
   identischer Zustand ist `unchanged` (idempotent). `force` nur nach
   Prüfung des Plans.
3. **Was verloren geht:** offene Reservierungen (Warenkörbe, TTL ≤ 15 min) und
   noch nicht nach D1 gedrainte `pending_movements`. Bewegungen, die ein
   fehlgeschlagener Flush nur in KV (`stock:movements:lost:*`, 14 Tage) ablegte,
   vorher nach `stock_movements` einspielen, sonst fehlen sie im Bestand.
4. **Prüfen:** `GET` des Bestands je SKU über die Admin-API gegen `plan.json`
   stichprobenartig vergleichen; danach die Maintenance-Sperre aufheben.

## Cutover

1. `wrangler d1 list` zeigt beide DBs.
2. `wrangler.toml` bindings auf `grosshandel-restore` umstellen.
3. `wrangler deploy` mit neuer Binding.
4. Smoke-Test: `pnpm smoke` gegen Prod-URL.
5. Alte DB als `archived` markieren (nicht löschen — Plan-Revision Daten-Aufbewahrungsfrist).

## DR-Drill (jährlich)

`.github/workflows/dr-drill.yml` triggered Yearly: Restore in Staging-D1, Smoke-Test, Report. Plan-Revision-Kandidat (initial leer).
