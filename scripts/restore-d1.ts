/**
 * M19 — D1-Restore aus einem Backup-Stand in R2.
 *
 * Ein Stand ist ein Präfix `backups/d1/<datum>/<datum>-<stunde>` mit
 * `_manifest.json` und je Tabelle `<tabelle>.jsonl` (siehe services/backup.ts).
 *
 * Ablauf:
 *   1. Manifest und Tabellen-Dateien aus R2 laden.
 *   2. Jede Datei gegen den Hash im Manifest prüfen — eine abweichende Datei
 *      bricht ab, BEVOR etwas geschrieben wird.
 *   3. Je Tabelle eine SQL-Datei bauen und mit EINEM `wrangler d1 execute
 *      --file` einspielen (vorher: ein Prozess je Zeile, bei echten Daten
 *      Stunden).
 *   4. Zeilen in der Ziel-DB zählen und gegen das Manifest vergleichen.
 *
 * Das Ziel muss eine D1 mit eingespieltem Schema sein (Migrationen). Bestehende
 * Zeilen gleicher Primärschlüssel werden ersetzt (INSERT OR REPLACE).
 *
 * Verwendung:
 *   pnpm tsx scripts/restore-d1.ts --bucket <r2-bucket> --prefix <stand> --target <d1-name> [--remote] [--env <env>] [--dry-run]
 */

import { parseArgs } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const { values } = parseArgs({
  options: {
    bucket: { type: "string" },
    prefix: { type: "string" },
    target: { type: "string" },
    remote: { type: "boolean", default: false },
    env: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.bucket || !values.prefix || !values.target) {
  console.error("--bucket, --prefix und --target sind Pflicht");
  process.exit(1);
}

const bucket = values.bucket as string;
const prefix = (values.prefix as string).replace(/\/$/, "");
const target = values.target as string;
const where = values.remote ? "--remote" : "--local";
const envArgs = values.env ? ["--env", values.env as string] : [];
const work = mkdtempSync(join(tmpdir(), "restore-d1-"));

// Wrangler direkt über Node starten, OHNE Shell: mit `shell: true` zerlegt
// Windows jedes Argument mit Leerzeichen (eine SQL-Abfrage) in Einzelwörter.
const wranglerJs = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
function wrangler(args: string[]): string {
  return execFileSync(process.execPath, [wranglerJs, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function fetchObject(key: string): string {
  const file = join(work, key.replace(/[\\/]/g, "_"));
  wrangler(["r2", "object", "get", `${bucket}/${key}`, where, "--file", file]);
  return readFileSync(file, "utf-8");
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const manifest = JSON.parse(fetchObject(`${prefix}/_manifest.json`)) as {
  counts: Record<string, number>;
  hashes: Record<string, string>;
  rows_total: number;
};
const tables = Object.keys(manifest.counts).filter((t) => manifest.counts[t]! >= 0);
const broken = Object.keys(manifest.counts).filter((t) => manifest.counts[t]! < 0);
if (broken.length > 0) console.warn(`⚠ im Backup fehlerhaft und übersprungen: ${broken.join(", ")}`);

// Phase 1: alles laden und prüfen, bevor geschrieben wird.
const bodies = new Map<string, string>();
for (const t of tables) {
  const body = fetchObject(`${prefix}/${t}.jsonl`);
  const got = sha256(body);
  if (got !== manifest.hashes[t]) {
    console.error(`✗ Hash weicht ab: ${t} (Manifest ${manifest.hashes[t]?.slice(0, 12)}, Datei ${got.slice(0, 12)}) — nichts geschrieben`);
    process.exit(1);
  }
  bodies.set(t, body);
}
console.log(`✓ ${tables.length} Tabellen geladen, alle Hashes stimmen (${manifest.rows_total} Zeilen laut Manifest)`);

// Phase 2: einspielen, eine SQL-Datei je Tabelle.
for (const t of tables) {
  const stmts: string[] = ["PRAGMA defer_foreign_keys = true;"];
  for (const line of (bodies.get(t) as string).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { _meta?: boolean; table?: string; row?: Record<string, unknown> };
    if (rec._meta || !rec.row) continue;
    const cols = Object.keys(rec.row);
    stmts.push(`INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(rec.row![c])).join(", ")});`);
  }
  if (stmts.length === 1) continue;
  const file = join(work, `${t}.sql`);
  writeFileSync(file, stmts.join("\n"));
  if (values["dry-run"]) {
    console.log(`(dry-run) ${t}: ${stmts.length - 1} Zeilen → ${file}`);
    continue;
  }
  wrangler(["d1", "execute", target, where, ...envArgs, "--yes", "--file", file]);
  console.log(`✓ ${t}: ${stmts.length - 1} Zeilen eingespielt`);
}
if (values["dry-run"]) process.exit(0);

// Phase 3: nachzählen.
let mismatch = 0;
for (const t of tables) {
  const out = wrangler(["d1", "execute", target, where, ...envArgs, "--json", "--command", `SELECT COUNT(*) AS n FROM ${t}`]);
  const n = (JSON.parse(out) as Array<{ results: Array<{ n: number }> }>)[0]?.results[0]?.n ?? -1;
  if (n < manifest.counts[t]!) {
    mismatch += 1;
    console.error(`✗ ${t}: ${n} Zeilen in der Ziel-DB, ${manifest.counts[t]} im Backup`);
  }
}
if (mismatch > 0) process.exit(1);
console.log(`\n✓ Restore vollständig: ${tables.length} Tabellen, ${manifest.rows_total} Zeilen, Zählung stimmt`);

export {};
