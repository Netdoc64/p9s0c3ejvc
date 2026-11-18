import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { resolvePricingFromDb } from "../services/pricing-resolver";

export const pricingRoutes = new Hono<AppContext>();

const QuoteSchema = z.object({
  customer_id: z.string().startsWith("cust_"),
  sku_id: z.string().startsWith("sku_"),
  qty: z.number().int().positive(),
  on_date: z.string().datetime().optional(),
});

pricingRoutes.post("/quote", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = QuoteSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const result = await resolvePricingFromDb(db, {
    tenant_id,
    customer_id: parsed.data.customer_id,
    sku_id: parsed.data.sku_id,
    qty: parsed.data.qty,
    on_date: parsed.data.on_date ?? new Date().toISOString(),
  });
  return c.json(result);
});
