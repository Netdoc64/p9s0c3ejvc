/**
 * M14 — Pilot-Seed (Blumen-Grosshandel)
 *
 * Idempotent: re-run merged ohne Daten zu zerstören (ON CONFLICT DO NOTHING).
 * Schreibt direkt in lokale miniflare-D1 oder remote via wrangler.
 *
 * Verwendung:
 *   pnpm seed:pilot [--remote] [--env staging] [--persist-to <dir>]
 *
 * --persist-to: nur lokal; waehlt das D1-Verzeichnis (wie bei wrangler), damit
 * der Smoke ohne Staging (scripts/smoke-local.mjs) eine frische DB nutzt.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash, randomBytes } from "node:crypto";

const { values } = parseArgs({
  options: {
    remote: { type: "boolean", default: false },
    env: { type: "string" },
    "persist-to": { type: "string" },
  },
  strict: true,
});
const REMOTE = Boolean(values.remote);
const ENV_FLAG = values.env ? `--env ${values.env as string}` : "";
const PERSIST = values["persist-to"] ? `--persist-to ${JSON.stringify(values["persist-to"] as string)}` : "";
const TARGET = REMOTE ? "--remote" : "--local";

// Fixed IDs für Snapshot-Stability
const T = "t_pilot";
const WH = "wh_main";
const BILLING: Record<string, { line1: string; postal_code: string; city: string }> = {
  cust_floraly_de: { line1: "Musterstraße 1", postal_code: "10115", city: "Berlin" },
  cust_blume_nl: { line1: "Musterstraat 2", postal_code: "1012 AB", city: "Amsterdam" },
  cust_florex_ch: { line1: "Musterweg 3", postal_code: "8001", city: "Zürich" },
};
const CUSTOMERS = {
  floraly: { id: "cust_floraly_de", name: "Floraly Berlin", country: "DE", b2b_b2c: "b2b", vat_id: "DE123456789", vat_status: "valid", email: "ops@floraly.example" },
  blume: { id: "cust_blume_nl", name: "Blume Amsterdam", country: "NL", b2b_b2c: "b2c", vat_id: null, vat_status: "not_required", email: "info@blume.example" },
  florex: { id: "cust_florex_ch", name: "Florex Zürich", country: "CH", b2b_b2c: "b2b", vat_id: "CHE-123.456.789", vat_status: "valid", email: "team@florex.example" },
};

const VARIETIES = ["Naomi", "Avalanche", "Aqua", "Red Sky", "Mondial"];
const LENGTHS = [40, 50, 60, 70];
const SKUS: Array<{ id: string; sku_code: string; name: string; tax_class: string; is_perishable: number; min_order_qty: number }> = [];
let nextSku = 1;
for (const variety of VARIETIES) {
  for (const len of LENGTHS) {
    SKUS.push({
      id: `sku_rose_${variety.toLowerCase().replace(/\s/g, "")}_${len}`,
      sku_code: `ROSE-${variety.toUpperCase().replace(/\s/g, "")}-${len}`,
      name: `Rose ${variety} ${len}cm`,
      tax_class: "standard",
      is_perishable: 1,
      min_order_qty: 1,
    });
    nextSku += 1;
  }
}
for (const variety of ["Pink", "Yellow", "White"]) {
  for (const len of [30, 40, 50]) {
    SKUS.push({
      id: `sku_tulip_${variety.toLowerCase()}_${len}`,
      sku_code: `TULIP-${variety.toUpperCase()}-${len}`,
      name: `Tulip ${variety} ${len}cm`,
      tax_class: "standard",
      is_perishable: 1,
      min_order_qty: 1,
    });
    nextSku += 1;
  }
}
for (const variety of ["Mini", "Standard"]) {
  SKUS.push({
    id: `sku_gerbera_${variety.toLowerCase()}`,
    sku_code: `GERBERA-${variety.toUpperCase()}`,
    name: `Gerbera ${variety}`,
    tax_class: "standard",
    is_perishable: 1,
    min_order_qty: 1,
  });
  nextSku += 1;
}

const PRICE_LIST_ID = "pl_pilot_default";

// Statements sammeln und am Ende in EINEM wrangler-Aufruf (--file) ausfuehren:
// ein Prozess je Statement dauerte minutenlang.
const statements: string[] = [];
function exec(sql: string): void {
  statements.push(sql.replace(/\s+/g, " ").trim());
}

function flush(): void {
  const dir = mkdtempSync(join(tmpdir(), "seed-pilot-"));
  const file = join(dir, "seed.sql");
  writeFileSync(file, statements.map((q) => `${q};`).join("\n"), "utf-8");
  try {
    execSync(`wrangler d1 execute DB ${TARGET} ${PERSIST} ${ENV_FLAG} --file ${JSON.stringify(file)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    console.error(`Seed fehlgeschlagen:\n${stderr instanceof Buffer ? stderr.toString("utf-8") : (stderr ?? "")}`);
    process.exit(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function nowIso(): string { return new Date().toISOString(); }
// Zufaelliges 192-Bit-Token (kein Passwort): SHA-256 reicht, der Worker vergleicht ebenso.
function sha(s: string): string { return createHash("sha256").update(s).digest("hex"); }
function rand32(): string { return randomBytes(32).toString("base64url"); }

console.log(`Seed → ${REMOTE ? "REMOTE" : "LOCAL"} D1${values.env ? ` (env=${values.env})` : ""}`);

// 1. Tenant
const bearerToken = `gh_${randomBytes(24).toString("base64url")}`;
const tokenRowId = "k_pilot_bootstrap";
const tokenDigest = sha(bearerToken);
const hmacSecret = rand32();
const jwtSecret = rand32();
const now = nowIso();

console.log(`Tenant: ${T}, API-Key: ${bearerToken} (NUR EINMAL angezeigt)`);

// Verkäuferangaben für Rechnungen (Migration 0021). Fiktiv, aber in gültiger
// Form; ohne sie stellt der Rechnungsdienst keine Rechnung aus (GH-PDF-002).
const TENANT_VAT_ID = "NL000000000B01";
const TENANT_ADDRESS = JSON.stringify({ line1: "Musterstraat 1", postal_code: "1000 AA", city: "Aalsmeer", country: "NL" });
exec(`INSERT OR IGNORE INTO tenants (id, slug, name, country, currency, customer_jwt_secret, status, min_shelf_life_days, vat_id, address, created_at, updated_at) VALUES ('${T}', 'pilot', 'Pilot-Tenant', 'NL', 'EUR', '${jwtSecret}', 'active', 3, '${TENANT_VAT_ID}', '${TENANT_ADDRESS}', '${now}', '${now}')`);
// Idempotent nachziehen, falls der Tenant aus einem älteren Seed stammt.
exec(`UPDATE tenants SET vat_id = COALESCE(vat_id, '${TENANT_VAT_ID}'), address = COALESCE(address, '${TENANT_ADDRESS}') WHERE id = '${T}'`);
exec(`INSERT OR IGNORE INTO api_keys (id, tenant_id, key_hash, hmac_secret, name, scope, created_at) VALUES ('${tokenRowId}', '${T}', '${tokenDigest}', '${hmacSecret}', 'bootstrap', 'full', '${now}')`);

// 2. Warehouse
exec(`INSERT OR IGNORE INTO warehouses (id, tenant_id, name, country, is_default, created_at) VALUES ('${WH}', '${T}', 'Aalsmeer Main', 'NL', 1, '${now}')`);

// 3. Customers
for (const c of Object.values(CUSTOMERS)) {
  // Je Kunde eine fiktive Anschrift im eigenen Land — vorher bekamen alle drei
  // dieselbe in Amsterdam, und die Rechnung an den DE-Kunden trug eine NL-Adresse.
  const billingAddr = JSON.stringify({ billing: { ...BILLING[c.id], country: c.country } });
  exec(`INSERT OR IGNORE INTO customers (id, tenant_id, name, email, country, b2b_b2c, vat_id, vat_status, addresses, metadata, created_at, updated_at) VALUES ('${c.id}', '${T}', '${c.name}', '${c.email}', '${c.country}', '${c.b2b_b2c}', ${c.vat_id ? `'${c.vat_id}'` : "NULL"}, '${c.vat_status}', '${billingAddr.replace(/'/g, "''")}', '{}', '${now}', '${now}')`);
}

// 4. SKUs
for (const sku of SKUS) {
  exec(`INSERT OR IGNORE INTO products (id, tenant_id, sku_code, name, tax_class, is_perishable, default_shelf_life_days, min_order_qty, packaging_units, attributes, status, created_at, updated_at) VALUES ('${sku.id}', '${T}', '${sku.sku_code}', '${sku.name.replace(/'/g, "''")}', 'standard', ${sku.is_perishable}, 7, ${sku.min_order_qty}, '[{"name":"carton","contains":50,"unit_of_inner":"stem"}]', '{}', 'active', '${now}', '${now}')`);
}

// 5. Price-List + Items
exec(`INSERT OR IGNORE INTO price_lists (id, tenant_id, name, currency, is_default, valid_from, created_at) VALUES ('${PRICE_LIST_ID}', '${T}', 'Default', 'EUR', 1, '${now}', '${now}')`);
let priceCount = 0;
for (const sku of SKUS) {
  // Pseudo-Price by length and variety: 50ct base + 10ct/10cm
  const lenMatch = sku.sku_code.match(/(\d+)$/);
  const len = lenMatch ? Number(lenMatch[1]) : 40;
  const price = 50 + len;
  exec(`INSERT OR IGNORE INTO price_list_items (id, price_list_id, sku_id, unit_price_cents, created_at) VALUES ('pli_${priceCount++}_${sku.id}', '${PRICE_LIST_ID}', '${sku.id}', ${price}, '${now}')`);
}

// 6. Qty-Breaks (carton-Mengenstaffel)
const breaks = [{ min: 10, off: 5 }, { min: 25, off: 10 }, { min: 50, off: 15 }];
let bCnt = 0;
for (const b of breaks) {
  exec(`INSERT OR IGNORE INTO qty_breaks (id, price_list_id, sku_id, min_qty, pct_off, created_at) VALUES ('qb_${bCnt++}', '${PRICE_LIST_ID}', NULL, ${b.min}, ${b.off}, '${now}')`);
}

// 7. Customer-Special-Prices für Floraly
for (const sku of SKUS.slice(0, 3)) {
  exec(`INSERT OR IGNORE INTO customer_special_prices (id, tenant_id, customer_id, sku_id, unit_price_cents, valid_from, created_at) VALUES ('csp_floraly_${sku.id}', '${T}', '${CUSTOMERS.floraly.id}', '${sku.id}', 80, '${now}', '${now}')`);
}

// 8. Stock initialisieren — als Movements (DO wird beim ersten POST /movements provisioniert)
//    v1: Direkt-INSERT in stock_movements ist ein Audit-Log; reale DO-State wird beim ersten Service-Call angelegt.
//    Pilot-Smoke nutzt POST /v1/stock/movements mit qty_delta=100 pro SKU.
let mCnt = 0;
for (const sku of SKUS) {
  exec(`INSERT OR IGNORE INTO stock_movements (id, tenant_id, warehouse_id, sku_id, type, qty_delta, reason, actor_id, created_at) VALUES ('sm_seed_${mCnt++}', '${T}', '${WH}', '${sku.id}', 'adjust', 100, 'pilot_seed', 'system', '${now}')`);
}

flush();
console.log(`✓ Seed fertig.`);
console.log(`Credentials (sicher speichern!):`);
console.log(`  tenant_id: ${T}`);
console.log(`  api_key:   ${bearerToken}`);
console.log(`  hmac_secret: ${hmacSecret}`);
console.log(`Test-Kunden: ${Object.values(CUSTOMERS).map((c) => c.id).join(", ")}`);
console.log(`SKUs: ${SKUS.length}, Customer-Special: 3, Mengenstaffeln: 3`);

export {};
