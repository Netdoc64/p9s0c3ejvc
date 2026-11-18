export type RecordStream = "catalog" | "offers";
export interface SupplierChange {
  id: string;
  sequence: number;
  deleted: boolean;
  data: Record<string, unknown>;
}
export interface SupplierPage {
  sequence: number;
  records: SupplierChange[];
}
export interface SupplierSource {
  readPage(stream: RecordStream, after: number): Promise<SupplierPage>;
}

export type SupplierConnection = {
  tenantId: string;
  provider: string;
  connection: string;
};

export async function syncSupplier(
  db: D1Database, key: SupplierConnection, source: SupplierSource, maxPages = 3,
) {
  const identity = [key.tenantId, key.provider, key.connection];
  const progress = [];
  for (const stream of ["catalog", "offers"] as const) {
    const scope = [...identity, stream];
    await db.prepare(`
      INSERT OR IGNORE INTO supplier_sync_state (tenant_id, provider, connection, stream)
      VALUES (?, ?, ?, ?)
    `).bind(...scope).run();
    const state = await db.prepare(`
      SELECT sequence FROM supplier_sync_state WHERE tenant_id = ? AND provider = ? AND connection = ? AND stream = ?
    `).bind(...scope).first<{ sequence: number }>();
    if (!state) throw new Error("Supplier sync state missing");

    let sequence = state.sequence;
    let processed = 0;
    let caughtUp = false;
    for (let i = 0; i < maxPages; i++) {
      const page = await source.readPage(stream, sequence);
      if (page.sequence < sequence || page.records.some((r) => r.sequence <= sequence || r.sequence > page.sequence)) {
        throw new Error("Invalid supplier synchronization sequence");
      }
      // Keep records and their cursor in one transaction. A competing sync can only
      // publish the page if its starting cursor still matches.
      const updated = await db.batch([
        db.prepare(`
          INSERT INTO supplier_records (tenant_id, provider, connection, stream, external_id, sequence, deleted, data)
          SELECT ?, ?, ?, ?, json_extract(record.value, '$.id'), json_extract(record.value, '$.sequence'),
                 json_extract(record.value, '$.deleted'), json_extract(record.value, '$.data')
          FROM json_each(?) AS record
          WHERE EXISTS (
            SELECT 1 FROM supplier_sync_state
            WHERE tenant_id = ? AND provider = ? AND connection = ? AND stream = ? AND sequence = ?
          )
          ON CONFLICT (tenant_id, provider, connection, stream, external_id) DO UPDATE
          SET sequence = excluded.sequence, deleted = excluded.deleted, data = excluded.data
          WHERE excluded.sequence > supplier_records.sequence
        `).bind(...scope, JSON.stringify(page.records), ...scope, sequence),
        db.prepare(`
          UPDATE supplier_sync_state SET sequence = ?, synced_at = ?
          WHERE tenant_id = ? AND provider = ? AND connection = ? AND stream = ? AND sequence = ?
        `).bind(page.sequence, new Date().toISOString(), ...scope, sequence),
      ]);
      if (updated[1]?.meta.changes !== 1) break;
      processed += page.records.length;
      caughtUp = page.sequence === sequence;
      sequence = page.sequence;
      if (caughtUp) break;
    }
    progress.push({ stream, sequence, processed, caught_up: caughtUp });
  }
  return progress;
}

export async function supplierList(
  db: D1Database, key: SupplierConnection, stream: RecordStream, after: string, limit: number,
) {
  const results = await db.prepare(`
    SELECT record.external_id, record.data, item.data AS article
    FROM supplier_records AS record
    LEFT JOIN supplier_records AS item ON item.tenant_id = record.tenant_id
      AND item.provider = record.provider AND item.connection = record.connection
      AND item.stream = 'catalog' AND item.deleted = 0 AND item.external_id = json_extract(record.data, '$.tradeItemId')
    WHERE record.tenant_id = ? AND record.provider = ? AND record.connection = ? AND record.stream = ?
      AND record.deleted = 0 AND record.external_id > ?
      AND (record.stream <> 'offers' OR julianday(json_extract(record.data, '$.orderPeriod.endDateTime')) > julianday('now'))
    ORDER BY record.external_id LIMIT ?
  `).bind(key.tenantId, key.provider, key.connection, stream, after, limit + 1)
    .all<{ external_id: string; data: string; article: string | null }>();
  const items = results.results.slice(0, limit);
  return {
    items: items.map((row) => ({
      ...JSON.parse(row.data) as Record<string, unknown>,
      ...(stream === "offers" ? { article: row.article ? JSON.parse(row.article) as unknown : null } : {}),
    })),
    next_after: results.results.length > limit ? items.at(-1)?.external_id ?? null : null,
  };
}

export async function supplierRecord<T>(
  db: D1Database, key: SupplierConnection, stream: RecordStream, id: string,
): Promise<T | null> {
  const row = await db.prepare(`
    SELECT data FROM supplier_records WHERE tenant_id = ? AND provider = ? AND connection = ?
      AND stream = ? AND external_id = ? AND deleted = 0
  `).bind(key.tenantId, key.provider, key.connection, stream, id).first<{ data: string }>();
  return row ? JSON.parse(row.data) as T : null;
}
