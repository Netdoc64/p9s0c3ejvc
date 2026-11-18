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
2. **Einspielen** über den internen Queue-Auftrag `stock_rebuild`. Eine
   HTTP-Route gibt es bewusst nicht. Auslösen kann nur, wer an die Queue senden
   darf (Cloudflare-Konto bzw. Binding).

   | Feld | Bedeutung |
   |---|---|
   | `kind` | immer `"stock_rebuild"` |
   | `force` | `true` überschreibt einen abweichenden DO-Zustand. Ohne `force` bleibt er stehen (Ergebnis `exists`). |
   | `targets` | optional: der geprüfte Plan aus Schritt 1 (`plan.json`). Fehlt er, berechnet der Worker den Plan selbst aus D1. |

   Die Nachricht geht an die Outbox-Queue der Umgebung (`grosshandel-outbox`
   bzw. `grosshandel-outbox-staging`, siehe `wrangler.toml`):

   - **Dashboard:** Queues → Queue der Umgebung → Nachricht senden, Inhalt als JSON.
   - **API:** `POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<QUEUE_ID>/messages`
     mit `{"body": {"kind": "stock_rebuild"}}`. Das Token kommt aus dem
     Schlüsselspeicher, nie aus einer Datei im Repo.

   Reihenfolge in der Praxis:
   1. Erst **ohne** `force` senden: `{"kind": "stock_rebuild"}`. Leere oder
      gleiche DOs werden aufgebaut bzw. bleiben `unchanged`.
   2. Das Ergebnis steht im Worker-Log als Ereignis `stock.rebuild` mit den
      Zählern `total`, `rebuilt`, `unchanged`, `exists` und `source` (`d1` oder
      `plan`).
   3. Nur wenn `exists > 0` und der Plan aus Schritt 1 geprüft ist: erneut mit
      `"force": true` senden, am besten mit `targets` aus `plan.json`.
      Nachrichten über 128 KB passen nicht in die Queue: bei großen Plänen
      `targets` weglassen, dann rechnet der Worker selbst aus D1.

   Fehler: Die Queue wiederholt den Auftrag (`msg.retry()`, höchstens
   `max_retries`, danach die Dead-Letter-Queue). Das ist gefahrlos, weil ein
   Wiederholen ohne `force` nichts überschreibt. Im Log stehen `queue.error`
   bzw. `queue.hard_fail` mit Code.

   Intern ruft der Auftrag `rebuildStockDO(env, targets, { force })` aus
   `src/services/stock-rebuild.ts` auf (DO-Aktion `/rebuild` per Stub).
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
