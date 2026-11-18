import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import * as stockSvc from "../services/stock";

export const stockRoutes = new Hono<AppContext>();

const MoveSchema = z.object({
  warehouse_id: z.string().startsWith("wh_"),
  sku_id: z.string().startsWith("sku_"),
  qty_delta: z.number().int(),
  reason: z.string().max(200).optional(),
});

stockRoutes.post("/movements", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = MoveSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  await stockSvc.adjust(c.env, {
    tenant_id,
    warehouse_id: parsed.data.warehouse_id,
    sku_id: parsed.data.sku_id,
    qty_delta: parsed.data.qty_delta,
    reason: parsed.data.reason,
    actor_id: c.var.api_key_id,
  });
  const state = await stockSvc.getAvailable(c.env, { tenant_id, warehouse_id: parsed.data.warehouse_id, sku_id: parsed.data.sku_id });
  return c.json({ ...state, applied: parsed.data.qty_delta }, 201);
});

stockRoutes.get("/state", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const warehouse_id = c.req.query("warehouse_id");
  const sku_id = c.req.query("sku_id");
  if (!warehouse_id || !sku_id) throw new CodedError("GH-INPUT-001", { reason: "warehouse_id+sku_id required" });
  const state = await stockSvc.getAvailable(c.env, { tenant_id, warehouse_id, sku_id });
  return c.json(state);
});
