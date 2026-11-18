/**
 * M19 — D1-Backup nach R2.
 * v1: SELECT-and-dump aller Tabellen als JSON.lines, gz-frei.
 * Plan-Revision: native `wrangler d1 export` SQL-Dump (CLI), Cross-Region-Replikation.
 */
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";

const BACKUP_TABLES = [
  "tenants", "api_keys",
  "customers",
  "products", "product_images",
  "price_lists", "price_list_items", "qty_breaks", "customer_special_prices", "customer_price_list_assignments",
  "tax_rules",
  "warehouses", "stock_movements", "stock_batches",
  "orders", "order_lines",
  "auth_authenticators", "auth_authorization_codes", "auth_refresh_tokens", "auth_magic_link_tokens",
  "outbox_events", "webhook_subscriptions", "webhook_deliveries",
  "tenant_pricing_feeds", "feed_runs",
  "client_min_versions",
  "invoices", "invoice_number_seq",
  "devices",
  "cron_runs", "cron_job_state",
];

export interface BackupResult {
  r2_key: string;
  bytes: number;
  hash: string;
  rows_total: number;
  table_counts: Record<string, number>;
}

/**
 * DSGVO Right-to-Erasure-Compromise (#P-007):
 * Backups werden 30 Tage aufbewahrt; ältere werden auto-purged. Längere
 * Retention würde Art. 17 DSGVO verletzen, kürzere wäre operativ riskant.
 */
const BACKUP_RETENTION_DAYS = 30;

export async function purgeOldBackups(env: Env): Promise<{ deleted: number }> {
  const cutoffMs = Date.now() - BACKUP_RETENTION_DAYS * 86_400_000;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const list = await env.ASSETS.list({ prefix: "backups/d1/", cursor, limit: 1000 });
    for (const obj of list.objects) {
      const uploaded = new Date(obj.uploaded).getTime();
      if (uploaded < cutoffMs) {
        await env.ASSETS.delete(obj.key);
        deleted += 1;
      }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { deleted };
}

/**
 * Daily-Backup, Streaming pro Tabelle (#C-006).
 *
 * Statt einem Riesen-Object: pro Tabelle ein R2-Object + ein Manifest oben drauf.
 * Vermeidet Worker-128MB-Hard-Cap und macht Restore granular.
 */
export async function dailyBackup(env: Env): Promise<BackupResult> {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const hourPart = now.toISOString().slice(11, 13);
  const prefix = `backups/d1/${datePart}/${datePart}-${hourPart}`;

  const counts: Record<string, number> = {};
  const tableHashes: Record<string, string> = {};
  let rowsTotal = 0;
  let totalBytes = 0;

  for (const table of BACKUP_TABLES) {
    try {
      // Pagination: D1 hat default page-limit; bei Riesen-Tabellen würde ein einzelnes
      // SELECT * trotzdem zu groß werden. Wir nutzen rowid-Cursor.
      const tableLines: string[] = [];
      tableLines.push(JSON.stringify({ _meta: true, table, schema_version: "build-plan/1.0", created_at: now.toISOString() }));
      let lastRowid = 0;
      const PAGE = 1000;
      let pageCount = 0;
      while (true) {
        const rs = await env.DB.prepare(`SELECT rowid AS __rid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(lastRowid, PAGE).all<Record<string, unknown> & { __rid: number }>();
        if (rs.results.length === 0) break;
        for (const row of rs.results) {
          const rid = row.__rid;
          const { __rid, ...clean } = row; void __rid;
          tableLines.push(JSON.stringify({ table, row: clean }));
          if (typeof rid === "number") lastRowid = rid;
        }
        pageCount += rs.results.length;
        if (rs.results.length < PAGE) break;
      }
      const body = tableLines.join("\n");
      const tableHash = await sha256Hex(body);
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      const tableKey = `${prefix}/${table}.jsonl`;
      await env.ASSETS.put(tableKey, body, {
        httpMetadata: { contentType: "application/x-ndjson" },
        customMetadata: { hash: tableHash, rows: String(pageCount), table, created_at: now.toISOString() },
      });
      counts[table] = pageCount;
      tableHashes[table] = tableHash;
      rowsTotal += pageCount;
      totalBytes += bodyBytes;
    } catch (err) {
      counts[table] = -1;
      console.error(JSON.stringify({ event: "backup.table_error", table, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  // Manifest oben — verlinkt alle Tabellen-Files
  const manifest = {
    schema_version: "build-plan/1.0",
    created_at: now.toISOString(),
    tables: BACKUP_TABLES,
    counts,
    hashes: tableHashes,
    rows_total: rowsTotal,
    bytes_total: totalBytes,
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  const manifestKey = `${prefix}/_manifest.json`;
  const manifestHash = await sha256Hex(manifestBody);
  await env.ASSETS.put(manifestKey, manifestBody, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { hash: manifestHash, rows_total: String(rowsTotal), schema_version: "build-plan/1.0" },
  });

  return { r2_key: manifestKey, bytes: totalBytes, hash: manifestHash, rows_total: rowsTotal, table_counts: counts };
}
