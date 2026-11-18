// Prueft [env.production] in wrangler.toml auf Platzhalter-IDs und fehlende Bindings.
// Reine Funktion pruefeProdConfig(tomlText) -> Liste der Befunde; CLI: Exit 1 bei Befunden.
// Keine Abhaengigkeit, kein Zugriff auf Cloudflare.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PFX = "env.production";

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function wert(roh) {
  const t = roh.trim();
  if (/^"[^"]*"$|^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  if (t.startsWith("{") && t.endsWith("}")) {
    const o = {};
    for (const m of t.slice(1, -1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/g)) {
      o[m[1]] = wert(m[2]);
    }
    return o;
  }
  return t;
}

/** Zerlegt TOML grob in Abschnitte { name, array, kv } (nur was wrangler.toml braucht). */
export function liesAbschnitte(tomlText) {
  const abschnitte = [{ name: "", array: false, kv: {} }];
  for (const roh of String(tomlText).split(/\r?\n/)) {
    const zeile = stripComment(roh).trim();
    if (!zeile) continue;
    const h = zeile.match(/^(\[\[?)\s*([^\]]+?)\s*\]\]?$/);
    if (h) {
      abschnitte.push({ name: h[2], array: h[1] === "[[", kv: {} });
      continue;
    }
    const kv = zeile.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv) abschnitte[abschnitte.length - 1].kv[kv[1]] = wert(kv[2]);
  }
  return abschnitte;
}

const istPlatzhalter = (v) => typeof v === "string" && /^[0\-]+$/.test(v) && /0/.test(v);

export function pruefeProdConfig(tomlText) {
  const befunde = [];
  const alle = liesAbschnitte(tomlText);
  const prod = alle.filter((a) => a.name === PFX || a.name.startsWith(PFX + "."));
  if (!prod.length) return [`[${PFX}] fehlt in wrangler.toml`];
  const arr = (n) => prod.filter((a) => a.array && a.name === `${PFX}.${n}`);

  const vars = { ...(prod.find((a) => a.name === PFX)?.kv.vars ?? {}) };
  for (const a of prod.filter((x) => x.name === `${PFX}.vars`)) Object.assign(vars, a.kv);
  if (vars.ENVIRONMENT !== "production") befunde.push('vars.ENVIRONMENT = "production" fehlt');
  if (!vars.WORKER_VERSION) befunde.push("vars.WORKER_VERSION fehlt");

  const db = arr("d1_databases").find((d) => d.kv.binding === "DB");
  if (!db) befunde.push("d1-Binding DB fehlt");
  else {
    if (!db.kv.database_id) befunde.push("d1 DB: database_id fehlt");
    else if (istPlatzhalter(db.kv.database_id)) befunde.push("d1 DB: database_id ist ein Platzhalter (0000…)");
    if (!db.kv.migrations_dir) befunde.push("d1 DB: migrations_dir fehlt");
  }

  const kv = arr("kv_namespaces").find((k) => k.kv.binding === "KV");
  if (!kv) befunde.push("kv-Binding KV fehlt");
  else if (!kv.kv.id) befunde.push("kv KV: id fehlt");
  else if (istPlatzhalter(kv.kv.id)) befunde.push("kv KV: id ist ein Platzhalter (0000…)");

  if (!arr("r2_buckets").some((r) => r.kv.binding === "ASSETS")) befunde.push("r2-Binding ASSETS fehlt");
  if (!arr("send_email").some((s) => s.kv.name === "EMAIL")) befunde.push("send_email-Binding EMAIL fehlt");

  if (!arr("queues.producers").some((p) => p.kv.binding === "OUTBOX_QUEUE")) {
    befunde.push("queues.producers: OUTBOX_QUEUE fehlt");
  }
  const cons = arr("queues.consumers");
  if (!cons.length) befunde.push("queues.consumers fehlt");
  else if (!cons.some((c) => c.kv.dead_letter_queue)) befunde.push("queues.consumers: dead_letter_queue fehlt");

  const dos = arr("durable_objects.bindings").map((d) => d.kv.name);
  for (const n of ["STOCK_DO", "CRON_LOCK_DO", "INVOICE_NUMBER_DO", "RATE_LIMIT_DO", "RETURNS_DO"]) {
    if (!dos.includes(n)) befunde.push(`durable_objects: ${n} fehlt`);
  }
  return befunde;
}

const istHauptmodul =
  typeof process !== "undefined" && process.argv?.[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (istHauptmodul) {
  const pfad = process.argv[2] ?? "wrangler.toml";
  const befunde = pruefeProdConfig(readFileSync(pfad, "utf8"));
  if (befunde.length) {
    console.error(`check-prod-config: ${befunde.length} Befund(e) in [${PFX}] (${pfad}):`);
    for (const b of befunde) console.error(`  - ${b}`);
    process.exit(1);
  }
  console.log(`check-prod-config: [${PFX}] ok`);
}
