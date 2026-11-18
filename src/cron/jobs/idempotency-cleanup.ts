import { lt } from "drizzle-orm";
import { getDb } from "../../db/client";
import { idempotency_locks } from "../../db/schema/idempotency";
import type { CronJob } from "../registry";

/**
 * Audit-Fix #I-001: Räumt Idempotency-Locks älter als 25h weg.
 * KV-Cache läuft nach 24h ab; D1-Lock-Tabelle muss aktiv gepruned werden.
 */
export const idempotencyCleanupJob: CronJob = {
  id: "idempotency-cleanup",
  cron: "15 */6 * * *",
  description: "Pruned abgelaufene Idempotency-Locks aus D1.",
  pause_after_failures: 5,
  handler: async ({ env }) => {
    const db = getDb(env.DB);
    const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.delete(idempotency_locks).where(lt(idempotency_locks.created_at, cutoff));
  },
};
