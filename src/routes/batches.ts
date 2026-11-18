import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { stock_batches } from "../db/schema/batches";
import * as stockSvc from "../services/stock";
import { newId } from "../lib/ids";

export const batchesRoutes = new Hono<AppContext>();

// qty cap (#V-009): defensive obergrenze gegen Eingabe-Fehler.
const ReceiveSchema = z.object({
  warehouse_id: z.string().startsWith("wh_"),
  sku_id: z.string().startsWith("sku_"),
  qty: z.number().int().positive().max(1_000_000),
  mhd: z.string().date().optional(),
  notes: z.string().max(500).optional(),
}).strict();

batchesRoutes.post("/", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = ReceiveSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const now = new Date().toISOString();
  const id = newId("event");
  await db.insert(stock_batches).values({
    id,
    tenant_id,
    warehouse_id: parsed.data.warehouse_id,
    sku_id: parsed.data.sku_id,
    qty: parsed.data.qty,
    mhd: parsed.data.mhd ?? null,
    received_at: now,
    status: "active",
    notes: parsed.data.notes ?? null,
    created_at: now,
  });

  // Auch DO-State erhöhen damit reserve() funktioniert.
  await stockSvc.adjust(c.env, {
    tenant_id,
    warehouse_id: parsed.data.warehouse_id,
    sku_id: parsed.data.sku_id,
    qty_delta: parsed.data.qty,
    reason: `batch_receive:${id}`,
    actor_id: c.var.api_key_id,
  });

  return c.json({ id, ...parsed.data, status: "active", received_at: now }, 201);
});

batchesRoutes.get("/", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const sku_id = c.req.query("sku_id");
  if (!sku_id) throw new CodedError("GH-INPUT-001", { reason: "sku_id required" });
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(stock_batches)
    .where(and(eq(stock_batches.tenant_id, tenant_id), eq(stock_batches.sku_id, sku_id), eq(stock_batches.status, "active")))
    .orderBy(stock_batches.mhd);
  return c.json({ items: rows });
});
