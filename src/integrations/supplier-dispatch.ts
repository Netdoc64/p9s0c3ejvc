import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";

export type DispatchScope = { tenant: string; provider: string; account: string };
type Dispatch = { id: string; status: "sending" | "unknown" | "submitted" | "rejected"; remote_id: string | null };
type StoredDispatch = Dispatch & { payload_hash: string };

const scopeValues = (scope: DispatchScope, id: string) => [scope.tenant, scope.provider, scope.account, id];

async function requireDispatch(db: D1Database, scope: DispatchScope, id: string) {
  const row = await db.prepare(`
    SELECT id, status, remote_id, payload_hash FROM supplier_dispatches
    WHERE tenant_id = ? AND provider = ? AND account = ? AND id = ?
  `).bind(...scopeValues(scope, id)).first<StoredDispatch>();
  if (!row) throw new CodedError("GH-SUPPLIER-002");
  return row;
}

function view({ id, status, remote_id }: StoredDispatch): Dispatch {
  return { id, status, remote_id };
}

export async function getSupplierDispatch(db: D1Database, scope: DispatchScope, id: string) {
  return view(await requireDispatch(db, scope, id));
}

export async function sendSupplierDispatch(
  db: D1Database, scope: DispatchScope, id: string, payload: string,
  send: () => Promise<string | null>, isRejection: (error: unknown) => boolean,
) {
  const values = scopeValues(scope, id);
  const hash = await sha256Hex(payload);
  // Persist the claim before sending and retain only a hash of the payload.
  const claim = await db.prepare(`
    INSERT INTO supplier_dispatches (tenant_id, provider, account, id, payload_hash, status)
    VALUES (?, ?, ?, ?, ?, 'sending') ON CONFLICT (tenant_id, provider, account, id) DO NOTHING
  `).bind(...values, hash).run();
  if (claim.meta.changes === 1) {
    let remoteId: string | null = null;
    let status: Dispatch["status"] = "submitted";
    try {
      remoteId = await send();
    } catch (error) {
      status = isRejection(error) ? "rejected" : "unknown";
    }
    await db.prepare(`
      UPDATE supplier_dispatches SET status = ?, remote_id = ?
      WHERE tenant_id = ? AND provider = ? AND account = ? AND id = ? AND status = 'sending'
    `).bind(status, remoteId, ...values).run();
  }
  const order = await requireDispatch(db, scope, id);
  if (order.payload_hash !== hash) throw new CodedError("GH-SUPPLIER-003", { reason: "order_id_already_used" });
  return view(order);
}

export async function linkSupplierDispatch(db: D1Database, scope: DispatchScope, id: string, remoteId: string) {
  await db.prepare(`
    UPDATE supplier_dispatches SET status = 'submitted', remote_id = ?
    WHERE tenant_id = ? AND provider = ? AND account = ? AND id = ? AND (remote_id IS NULL OR remote_id = ?)
  `).bind(remoteId, ...scopeValues(scope, id), remoteId).run();
  const order = await getSupplierDispatch(db, scope, id);
  if (order.remote_id !== remoteId) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "different_provider_order_id" });
  }
  return order;
}
