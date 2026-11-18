import type { Env } from "../env";
import { CodedError, type ErrorCode } from "../errors/catalog";
import { SupplierHandoff, type CreateReturnInput, type DeliveryInput, type ReturnCommand } from "../schemas/returns";

export type ReturnActor =
  | { role: "b2b"; id: string }
  | { role: "customer"; id: string }
  | { role: "supplier"; id: string };

export type ReturnRequest =
  | { action: "get"; actor: ReturnActor; case_id: string }
  | { action: "list"; actor: ReturnActor; after?: string }
  | { action: "deliveries"; actor: ReturnActor; after?: string }
  | { action: "delivery"; actor: ReturnActor; lines: Array<{ line_no: number; sku_id: string; qty: number }>; input: DeliveryInput }
  | { action: "create"; actor: ReturnActor; customer_id: string; input: CreateReturnInput }
  | { action: "command"; actor: ReturnActor; case_id: string; input: ReturnCommand };

export async function callReturns(
  env: Env, tenantId: string, orderId: string, request: ReturnRequest,
): Promise<unknown> {
  const namespace = env.RETURNS_DO;
  const stub = namespace.get(namespace.idFromName(JSON.stringify([tenantId, orderId])));
  const response = await stub.fetch("https://returns.internal/cases", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId, order_id: orderId, ...request }),
  });
  if (!response.ok) {
    const error = await response.json<{ code: ErrorCode; details?: Record<string, unknown> }>();
    throw new CodedError(error.code, error.details);
  }
  return response.json();
}

export async function sendSupplierHandoff(env: Env, handoff: SupplierHandoff): Promise<void> {
  if (!env.RETURNS_SUPPLIER_EDGE) throw new CodedError("GH-RET-003", { reason: "supplier_edge_unconfigured" });
  try {
    const response = await env.RETURNS_SUPPLIER_EDGE.fetch("https://returns-supplier.internal/v1/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(handoff),
      signal: AbortSignal.timeout(3500),
      redirect: "manual",
    });
    if (response.ok) {
      const ack = await response.json<{ handoff_id?: unknown; accepted?: unknown }>();
      if (ack.accepted === true && ack.handoff_id === handoff.handoff_id) return;
    }
  } catch (error) {
    // The receiver may already have persisted the handoff. Retry with its original ID.
    console.warn("returns.supplier_ack_unavailable", { handoff_id: handoff.handoff_id, error: error instanceof Error ? error.name : "unknown" });
  }
  throw new CodedError("GH-RET-003", { reason: "supplier_ack_missing" });
}
