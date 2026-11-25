import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import * as stockSvc from "../services/stock";
import { signCursor, verifyCursor } from "../lib/cursor";

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

/**
 * Bestandsübersicht für das Händler-Dashboard: alle Kombinationen aus Lager und
 * Artikel, für die es je eine Bewegung gab, mit aktuellem Stand aus dem
 * Bestands-Objekt. Seitenweise (höchstens 50), weil jede Zeile ein DO-Aufruf ist.
 * Eine leere Liste ist 200; fehlende Berechtigung ist 401/403, nie eine leere Liste.
 */
stockRoutes.get("/overview", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const limitRaw = Number(c.req.query("limit") ?? 50);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) throw new CodedError("GH-INPUT-001", { field: "limit" });
  const warehouse = c.req.query("warehouse_id");
  if (warehouse !== undefined && !warehouse.startsWith("wh_")) throw new CodedError("GH-INPUT-001", { field: "warehouse_id" });
  const raw = c.req.query("cursor");
  const after = raw ? await verifyCursor<{ w: string; s: string }>(c.env, raw) : null;

  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT warehouse_id, sku_id FROM stock_movements
      WHERE tenant_id = ?1
        AND (?2 IS NULL OR warehouse_id = ?2)
        AND (?3 IS NULL OR warehouse_id > ?3 OR (warehouse_id = ?3 AND sku_id > ?4))
      ORDER BY warehouse_id, sku_id LIMIT ?5`,
  ).bind(tenant_id, warehouse ?? null, after?.w ?? null, after?.s ?? "", limitRaw + 1).all<{ warehouse_id: string; sku_id: string }>();
  const page = (rows.results ?? []).slice(0, limitRaw);
  const items = await Promise.all(page.map(async (r) => {
    const st = await stockSvc.getAvailable(c.env, { tenant_id, warehouse_id: r.warehouse_id, sku_id: r.sku_id });
    return { warehouse_id: r.warehouse_id, sku_id: r.sku_id, available: st.available, reserved: st.reserved };
  }));
  const last = page.at(-1);
  const next_cursor = (rows.results ?? []).length > limitRaw && last ? await signCursor(c.env, { w: last.warehouse_id, s: last.sku_id }) : null;
  return c.json({ items, next_cursor });
});
