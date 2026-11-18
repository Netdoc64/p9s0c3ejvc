import { inArray, min } from "drizzle-orm";
import { getDb } from "../../db/client";
import { outbox_events } from "../../db/schema/webhooks";
import { gauge } from "../../observability/metrics";
import { sweepStuck } from "../../services/outbox";
import type { CronJob } from "../registry";

/** Alter (Sekunden) des aeltesten noch nicht zugestellten Events; 0 = nichts offen. */
async function emitOutboxLag(env: Parameters<typeof sweepStuck>[0]): Promise<void> {
  const db = getDb(env.DB);
  const [row] = await db
    .select({ oldest: min(outbox_events.created_at) })
    .from(outbox_events)
    .where(inArray(outbox_events.status, ["pending", "retrying"]));
  const oldest = row?.oldest ? Date.parse(row.oldest) : NaN;
  const lag = Number.isFinite(oldest) ? Math.max(0, Math.round((Date.now() - oldest) / 1000)) : 0;
  gauge("outbox.lag_seconds", lag);
}

export const outboxSweepJob: CronJob = {
  id: "outbox-sweep",
  cron: "*/5 * * * *",
  description: "Schiebt liegen gebliebene Outbox-Events in die Queue (alle 5min, #C-005).",
  pause_after_failures: 5,
  handler: async ({ env }) => {
    await sweepStuck(env);
    try {
      await emitOutboxLag(env);
    } catch (err) {
      console.error(JSON.stringify({ event: "outbox.lag_error", error: err instanceof Error ? err.message : String(err) }));
    }
  },
};
