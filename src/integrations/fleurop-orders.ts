import type { z } from "zod";
import { CodedError } from "../errors/catalog";
import { FleuropError, type FleuropClient, type fleuropOrder } from "./fleurop";
import { getSupplierDispatch, linkSupplierDispatch, sendSupplierDispatch } from "./supplier-dispatch";

const scope = (tenant: string, client: FleuropClient) => ({ tenant, account: client.account, provider: "fleurop-nl" });

export async function requireFleuropOrder(db: D1Database, tenant: string, client: FleuropClient, id: string) {
  return getSupplierDispatch(db, scope(tenant, client), id);
}

export async function placeFleuropOrder(db: D1Database, tenant: string, client: FleuropClient, input: z.infer<typeof fleuropOrder>) {
  if (!client.orderingEnabled) throw new CodedError("GH-SUPPLIER-001", { reason: "ordering_disabled" });
  const payload = client.payload(input);
  return sendSupplierDispatch(db, scope(tenant, client), input.id, payload, () => client.submit(payload),
    (error) => error instanceof FleuropError && [401, 403].includes(error.status));
}

export async function reconcileFleuropOrder(db: D1Database, tenant: string, client: FleuropClient, id: string, remoteId: string) {
  const local = await requireFleuropOrder(db, tenant, client, id);
  if (local.remote_id && local.remote_id !== remoteId) {
    throw new CodedError("GH-SUPPLIER-003", { reason: "different_provider_order_id" });
  }
  const status = await client.status(remoteId, id);
  return { ...await linkSupplierDispatch(db, scope(tenant, client), id, remoteId), ...status };
}
