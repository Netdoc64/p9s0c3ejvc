import { getDb } from "../../db/client";
import { cleanupExpiredPreviousSecrets } from "../../services/rotation";
import type { CronJob } from "../registry";

/**
 * Daily-Cleanup: nullt `*_previous`-Spalten nach Karenzfrist.
 */
export const secretRotationCleanupJob: CronJob = {
  id: "secret-rotation-cleanup",
  cron: "30 3 * * *",
  description: "Räumt abgelaufene previous-Secrets in api_keys + tenants weg.",
  handler: async ({ env }) => {
    const db = getDb(env.DB);
    await cleanupExpiredPreviousSecrets(db);
  },
};
