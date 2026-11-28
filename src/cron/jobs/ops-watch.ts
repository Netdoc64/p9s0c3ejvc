import type { CronJob } from "../registry";
import { watch } from "../../ops/watch";

export const opsWatchJob: CronJob = {
  id: "ops-watch",
  cron: "*/15 * * * *",
  description: "Betriebs-Wächter: Alarmlage aus D1 bewerten, Änderungen per Mail melden.",
  pause_after_failures: false,
  handler: async ({ env }) => {
    await watch(env);
  },
};
