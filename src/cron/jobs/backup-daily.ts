import { dailyBackup, purgeOldBackups } from "../../services/backup";
import { counter } from "../../observability/metrics";
import type { CronJob } from "../registry";

/**
 * Backup-Cadence: 6h (RPO=6h). Production-Hardening:
 * Spec verlangt 1h (RPO 1h). Plan-Revision-Kandidat: hourly via "0 * * * *",
 * sobald CF-Costs/Quota-Auswirkungen geprüft sind.
 */
export const backupDailyJob: CronJob = {
  id: "backup-snapshot",
  cron: "0 * * * *",
  description: "D1-Snapshot nach R2 (jsonl). Hash + rows_total in customMetadata. Cadence: 1h (RPO=1h, #C-007).",
  pause_after_failures: 3,
  handler: async ({ env }) => {
    let result: Awaited<ReturnType<typeof dailyBackup>>;
    try {
      result = await dailyBackup(env);
    } catch (err) {
      counter("backup.daily.failed", 1);
      throw err;
    }
    console.log(JSON.stringify({ event: "backup.snapshot", ...result }));
    // DSGVO 30d-Retention (#P-007). Best-effort.
    try {
      const purge = await purgeOldBackups(env);
      console.log(JSON.stringify({ event: "backup.purge", ...purge }));
    } catch (err) {
      console.error(JSON.stringify({ event: "backup.purge_error", error: err instanceof Error ? err.message : String(err) }));
    }
  },
};
