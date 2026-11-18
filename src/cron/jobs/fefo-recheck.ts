import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../db/client";
import { stock_batches } from "../../db/schema/batches";
import * as stockSvc from "../../services/stock";
import type { CronJob } from "../registry";

/**
 * Daily-Job: alle aktiven Batches mit `mhd <= today` als 'expired' markieren
 * und das DO entsprechend per `adjust(-qty)` reduzieren.
 */
export const fefoRecheckJob: CronJob = {
  id: "fefo-recheck",
  cron: "0 3 * * *",
  description: "Markiert abgelaufene Batches als 'expired' und schreibt sie aus dem Stock.",
  pause_after_failures: 5,
  handler: async ({ env }) => {
    const db = getDb(env.DB);
    const today = new Date().toISOString().slice(0, 10);
    // #C-010: Cap auf 500 pro Run, damit Worker-CPU-Limit nicht trifft.
    // Übersprungene Batches landen im nächsten Cron-Tick.
    const expiring = await db
      .select()
      .from(stock_batches)
      .where(and(eq(stock_batches.status, "active"), lt(stock_batches.mhd, today)))
      .limit(500);
    for (const b of expiring) {
      await db.update(stock_batches).set({ status: "expired", expired_at: new Date().toISOString() }).where(eq(stock_batches.id, b.id));
      await stockSvc.adjust(env, {
        tenant_id: b.tenant_id,
        warehouse_id: b.warehouse_id,
        sku_id: b.sku_id,
        qty_delta: -b.qty,
        reason: `expired_batch:${b.id}`,
        actor_id: "system:fefo-recheck",
      });
    }
  },
};
