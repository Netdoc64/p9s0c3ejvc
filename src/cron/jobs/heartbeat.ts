import type { CronJob } from "../registry";

/**
 * Smoke-Heartbeat — persistiert KV-Marker mit Last-Run-Timestamp (#C-013).
 * Erlaubt extern (Health-Endpoint, Monitor) zu prüfen, ob Cron-Framework lebt.
 */
export const heartbeatJob: CronJob = {
  id: "heartbeat",
  cron: "*/15 * * * *",
  description: "KV-Marker mit Last-Run-Timestamp; cron_runs-Insert via Runner.",
  handler: async ({ env }) => {
    try {
      await env.KV.put("cron:heartbeat:last", new Date().toISOString(), { expirationTtl: 24 * 60 * 60 });
    } catch {
      // KV-Outage: Cron läuft trotzdem; cron_runs-Insert übernimmt der Runner.
    }
  },
};
