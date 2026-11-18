import { z } from "zod";
import { CodedError } from "../errors/catalog";
import type { SupplierConnection } from "./supplier-sync";

export const snapshotSource = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const snapshotSku = z.string().trim().min(1).max(100);
export const snapshotOffer = z.strictObject({
  sku: snapshotSku,
  name: z.string().trim().min(1).max(160),
  unit: z.string().trim().min(1).max(32),
  unit_price: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  available_quantity: z.number().int().nonnegative(),
  minimum_quantity: z.number().int().positive(),
});
export const snapshotInput = z.strictObject({
  revision: z.number().int().positive(),
  expires_at: z.iso.datetime({ offset: true }),
  items: z.array(snapshotOffer).max(500),
}).superRefine(({ items }, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.sku)) {
      context.addIssue({ code: "custom", path: ["items", index, "sku"], message: "Duplicate SKU" });
    }
    seen.add(item.sku);
  }
});

type Snapshot = z.infer<typeof snapshotInput>;

export function snapshotConnection(tenantId: string, source: string): SupplierConnection {
  return { tenantId, provider: "file-import", connection: source };
}

async function readSnapshot(db: D1Database, key: SupplierConnection) {
  return db.prepare(`
    SELECT data FROM supplier_records
    WHERE tenant_id = ? AND provider = ? AND connection = ? AND stream = 'offers' AND external_id = 'snapshot'
  `).bind(key.tenantId, key.provider, key.connection).first<string>("data");
}

export async function importSnapshot(db: D1Database, key: SupplierConnection, input: Snapshot) {
  const snapshot = {
    ...input,
    expires_at: new Date(input.expires_at).toISOString(),
    items: [...input.items].sort((a, b) => {
      if (a.sku === b.sku) return 0;
      return a.sku < b.sku ? -1 : 1;
    }),
  };
  const data = JSON.stringify(snapshot);
  const written = await db.prepare(`
    INSERT INTO supplier_records (tenant_id, provider, connection, stream, external_id, sequence, data)
    VALUES (?, ?, ?, 'offers', 'snapshot', ?, ?)
    ON CONFLICT (tenant_id, provider, connection, stream, external_id) DO UPDATE
    SET sequence = excluded.sequence, data = excluded.data
    WHERE excluded.sequence > supplier_records.sequence
    RETURNING sequence
  `).bind(key.tenantId, key.provider, key.connection, snapshot.revision, data).first<number>("sequence");

  if (written === null && await readSnapshot(db, key) !== data) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "stale_or_conflicting_snapshot" });
  }
  return { revision: snapshot.revision, imported: snapshot.items.length, applied: written !== null };
}

export async function listSnapshot(db: D1Database, key: SupplierConnection, after: string, limit: number) {
  const stored = await readSnapshot(db, key);
  if (stored === null) throw new CodedError("GH-SUPPLIER-002");
  const { revision, expires_at, items } = JSON.parse(stored) as Snapshot;
  const expires = Date.parse(expires_at);
  const matches = expires > Date.now() ? items.filter((item) => item.sku > after) : [];
  const page = matches.slice(0, limit);
  return { revision, expires_at, items: page, next_after: matches.length > limit ? page.at(-1)?.sku ?? null : null };
}
