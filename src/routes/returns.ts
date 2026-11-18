import { Hono, type Context } from "hono";
import type { z } from "zod";
import { getDb } from "../db/client";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { requireById } from "../repos/orders";
import { CreateReturnInput, DeliveryInput, ReturnCommandInput, ReturnRef, SupplierHandoff } from "../schemas/returns";
import { callReturns, type ReturnActor } from "../services/returns";

type ReturnContext = Context<AppContext>;
type BuyerRole = "b2b" | "customer";

function tenant(c: ReturnContext): string {
  const id = c.var.tenant_id;
  if (!id) throw new CodedError("GH-AUTH-001");
  return id;
}

function buyer(c: ReturnContext, role: BuyerRole, write = false): ReturnActor {
  if (role === "b2b") return { role, id: tenant(c) };
  const id = c.var.customer_id;
  if (!id || !c.var.scopes?.some((scope) => scope === "customer_self" || scope === `customer_self.${write ? "write" : "read"}`)) {
    throw new CodedError("GH-AUTH-004");
  }
  return { role, id };
}

function reference(value: string | undefined): string {
  const result = ReturnRef.safeParse(value);
  if (!result.success) throw new CodedError("GH-INPUT-001", { reason: "invalid_reference" });
  return result.data;
}

async function input<T extends z.ZodType>(c: ReturnContext, schema: T): Promise<z.output<T>> {
  const value = await c.req.json().catch(() => null);
  const result = schema.safeParse(value);
  if (!result.success) throw new CodedError("GH-INPUT-001", { issues: result.error.flatten() });
  return result.data;
}

async function order(c: ReturnContext, actor: ReturnActor, orderId: string) {
  const { doc } = await requireById(getDb(c.env.DB), tenant(c), orderId);
  if (actor.role === "customer" && actor.id !== doc.customer_id) throw new CodedError("GH-ORDER-001");
  return doc;
}

function buyerRoutes(role: BuyerRole) {
  const routes = new Hono<AppContext>();
  routes.get("/:orderId/return-deliveries", async (c) => {
    const actor = buyer(c, role);
    const orderId = reference(c.req.param("orderId"));
    await order(c, actor, orderId);
    const rawAfter = c.req.query("after");
    const after = rawAfter !== undefined ? reference(rawAfter) : undefined;
    return c.json(await callReturns(c.env, tenant(c), orderId, { action: "deliveries", actor, after }));
  });
  routes.get("/:orderId/returns", async (c) => {
    const actor = buyer(c, role);
    const orderId = reference(c.req.param("orderId"));
    await order(c, actor, orderId);
    const rawAfter = c.req.query("after");
    const after = rawAfter !== undefined ? reference(rawAfter) : undefined;
    return c.json(await callReturns(c.env, tenant(c), orderId, { action: "list", actor, after }));
  });
  routes.post("/:orderId/returns", async (c) => {
    const actor = buyer(c, role, true);
    const orderId = reference(c.req.param("orderId"));
    const doc = await order(c, actor, orderId);
    const data = await input(c, CreateReturnInput);
    return c.json(await callReturns(c.env, tenant(c), orderId, {
      action: "create", actor, customer_id: doc.customer_id, input: data,
    }), 201);
  });
  routes.get("/:orderId/returns/:caseId", async (c) => {
    const actor = buyer(c, role);
    const orderId = reference(c.req.param("orderId"));
    const caseId = reference(c.req.param("caseId"));
    return c.json(await callReturns(c.env, tenant(c), orderId, { action: "get", actor, case_id: caseId }));
  });
  return routes;
}

export const customerReturnsRoutes = buyerRoutes("customer");
export const returnsRoutes = buyerRoutes("b2b");

returnsRoutes.post("/:orderId/return-deliveries", async (c) => {
  const actor = buyer(c, "b2b");
  const orderId = reference(c.req.param("orderId"));
  const doc = await order(c, actor, orderId);
  if (!["confirmed", "shipped", "invoiced", "paid"].includes(doc.state.current)) {
    throw new CodedError("GH-RET-002", { reason: "order_not_confirmed" });
  }
  const data = await input(c, DeliveryInput);
  return c.json(await callReturns(c.env, tenant(c), orderId, {
    action: "delivery", actor, input: data, lines: doc.lines.map(({ line_no, qty, sku_id }) => ({ line_no, qty, sku_id })),
  }), 201);
});

returnsRoutes.post("/:orderId/returns/:caseId/commands", async (c) => {
  const actor = buyer(c, "b2b");
  const orderId = reference(c.req.param("orderId"));
  const caseId = reference(c.req.param("caseId"));
  return c.json(await callReturns(c.env, tenant(c), orderId, {
    action: "command", actor, case_id: caseId, input: await input(c, ReturnCommandInput),
  }));
});

export const supplierReturnsRoutes = new Hono<AppContext>();

supplierReturnsRoutes.get("/return-inbox", async (c) => {
  const supplier = tenant(c);
  const rawAfter = c.req.query("after");
  const after = rawAfter !== undefined ? reference(rawAfter) : "";
  const db = c.env.DB.withSession?.("first-primary") ?? c.env.DB;
  const { results } = await db
    .prepare(`SELECT payload, accepted_at, handoff_id FROM supplier_return_handoffs
      WHERE supplier_tenant_id = ? AND handoff_id > ? ORDER BY handoff_id LIMIT 51`)
    .bind(supplier, after).all<{ payload: string; accepted_at: string; handoff_id: string }>();
  return c.json({
    items: results.slice(0, 50).map(({ payload, accepted_at }) => ({
      ...SupplierHandoff.parse(JSON.parse(payload)),
      accepted_at,
    })),
    next: results.length > 50 ? results[49]?.handoff_id : null,
  });
});

supplierReturnsRoutes.get("/:ownerTenantId/orders/:orderId/returns/:caseId", async (c) => {
  const owner = reference(c.req.param("ownerTenantId"));
  const orderId = reference(c.req.param("orderId"));
  const caseId = reference(c.req.param("caseId"));
  const actor: ReturnActor = { role: "supplier", id: tenant(c) };
  return c.json(await callReturns(c.env, owner, orderId, { action: "get", actor, case_id: caseId }));
});

supplierReturnsRoutes.post("/:ownerTenantId/orders/:orderId/returns/:caseId/commands", async (c) => {
  const owner = reference(c.req.param("ownerTenantId"));
  const orderId = reference(c.req.param("orderId"));
  const caseId = reference(c.req.param("caseId"));
  const actor: ReturnActor = { role: "supplier", id: tenant(c) };
  return c.json(await callReturns(c.env, owner, orderId, {
    action: "command", actor, case_id: caseId, input: await input(c, ReturnCommandInput),
  }));
});
