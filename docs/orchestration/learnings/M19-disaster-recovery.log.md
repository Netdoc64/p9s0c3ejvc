# M19 — Learnings

### What happened
`services/backup.ts` (D1-Snapshot als jsonl in R2 mit hash + customMetadata), Cron `backup-daily` (täglich 02:00), Restore-Skript `scripts/restore-d1.ts`, Runbook `docs/runbooks/disaster-restore.md`.

### Decisions
1. **JSONL-Format** statt SQL-Dump: einfacher Worker-nativ (kein wrangler-Shell-Out), portabel, jede Zeile selbst-beschreibend (`{table, row}`). Plan-Revision-Kandidat: SQL-Dump via `wrangler d1 export` für direkte SQLite-Restore.
2. **Single-File pro Tag/Stunde** statt Per-Tabelle-Files. RTO-optimiert (1 R2-Read, kein Glob).
3. **Cross-Region-Replikation**: Plan-Revision-Kandidat. R2 hat eingebaute Multi-Region-Datasets; Configuration ist Setup-Schritt (nicht Code).
4. **DR-Drill-Workflow**: `.github/workflows/dr-drill.yml` ist Stub-leer — Plan-Revision-Kandidat wenn Staging existiert.

### RTO/RPO Status
- RPO: 23h v1 (täglich 02:00). Spec ist 1h. Plan-Revision-Kandidat: hourly cron mit incremental-Backup.
- RTO: ~30min (R2-Read + Migrations + Restore-Loop für ~10k Rows).

## 2026-11-17 — erster echter Restore-Drill (Staging)

- `scripts/restore-d1.ts` war ein Stub: las eine lokale Datei in einem Format, das das Backup nicht schreibt (eine `jsonl` statt Manifest + je Tabelle), prüfte keine Hashes und startete je Zeile einen eigenen `wrangler`-Prozess. Neu: lädt einen Stand aus R2, prüft jeden Hash gegen das Manifest **bevor** geschrieben wird, spielt je Tabelle eine SQL-Datei ein, zählt nach. Drill: 31 Tabellen / 144 Zeilen in 3,5 min, alles grün.
- Windows: mit `shell: true` zerlegt `execFileSync` jedes Argument mit Leerzeichen (eine SQL-Abfrage). Wrangler wird direkt über Node gestartet.
- **Offen:** Der Bestand in den Durable Objects ist nicht Teil des D1-Backups. `backup-do-stock.ts` / `restore-do-stock.ts` aus dem Modulplan existieren nicht, obwohl das Modul `shipped` war. Bei D1-Schaden unkritisch (DOs bleiben), bei DO-Verlust fehlt ein Rebuild aus `stock_movements`.

## 2026-11-18 — DO-Bestand-Rebuild

- Neu: `src/services/stock-rebuild.ts` (reine Berechnung `computeStockTargets` + `rebuildStockDO`), DO-Aktion `/rebuild` in `src/do/stock.ts`, Plan-Skript `scripts/rebuild-stock.ts` (nur lesend), Test `tests/dr/stock-rebuild.spec.ts`. Runbook `disaster-restore.md` um den Schritt ergänzt.
- Zielbestand = Summe `qty_delta` aus `stock_movements`; aktive `stock_batches` sind nur Gegencheck (Abweichung = Hinweis). Offene Reservierungen und nicht gedrainte `pending_movements` sind nicht rekonstruierbar und werden verworfen.
- `/rebuild` überschreibt abweichenden Zustand nur mit `force` (sonst 409), identischer Zustand ist ein No-op → idempotent. Nur per Stub erreichbar; Test prüft, dass v1-Routen es nicht ausliefern.
- Test-Pool: Antworten von `stub.fetch` immer vollständig lesen und offene Reservierungs-Alarme abarbeiten (`runDurableObjectAlarm`), sonst „Isolated storage failed" (`.sqlite-shm`).
- **Offen:** Es gibt keinen Betriebs-Einstieg, der `rebuildStockDO` gegen die echten DOs aufruft (bewusst keine Route). Nötig wäre ein interner Auslöser (z. B. geschützter Queue-/Cron-Handler oder Service-Binding).

## 2026-11-18 — Interner Auslöser für den Rebuild

- Betriebs-Einstieg ist ein Queue-Auftrag `{ kind: "stock_rebuild", force?, targets? }` auf `OUTBOX_QUEUE` (`src/workers/queue-handler.ts` → `src/services/stock-rebuild-run.ts`). Keine HTTP-Route; auslösen kann nur, wer an die Queue senden darf (Cloudflare-Konto/Binding). Ohne `targets` wird der Plan aus D1 berechnet, mit `targets` ein vorher geprüfter Plan (`scripts/rebuild-stock.ts --out`) eingespielt.
- Fehler → `msg.retry()` (idempotent, ohne `force` überschreibt ein Wiederholen nichts); Ergebnis als Log `stock.rebuild` (Zähler rebuilt/unchanged/exists). Nachrichten >128 KB passen nicht in die Queue — bei sehr großen Plänen den Plan weglassen (D1-Berechnung).
- Test: `tests/dr/stock-rebuild-trigger.spec.ts`. **Offen:** Runbook `disaster-restore.md` Schritt 2 nennt noch „nur aus dem Worker-Code“ und sollte den Queue-Auftrag beschreiben.

## 2026-11-18 — Runbook zum Queue-Auftrag

- `docs/runbooks/disaster-restore.md` Schritt 2 beschreibt jetzt den Queue-Auftrag `stock_rebuild`: Nachrichtenform, Senden über Dashboard oder API, erst ohne `force`, Erfolg am Log `stock.rebuild`, Fehler über Retry/Dead-Letter. Der offene Punkt aus dem vorigen Eintrag ist damit erledigt.
