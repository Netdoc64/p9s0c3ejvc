import type { Env } from "../env";
import { allJobs, getJobByCron, registerJob } from "./registry";
import { runJob } from "./runner";
import { supplierSyncJob } from "./jobs/supplier-sync";
import { opsWatchJob } from "./jobs/ops-watch";
import { heartbeatJob } from "./jobs/heartbeat";
import { fefoRecheckJob } from "./jobs/fefo-recheck";
import { secretRotationCleanupJob } from "./jobs/secret-rotation-cleanup";
import { pricingFeedPullJob } from "./jobs/pricing-feed-pull";
import { outboxSweepJob } from "./jobs/outbox-sweep";
import { backupDailyJob } from "./jobs/backup-daily";
import { idempotencyCleanupJob } from "./jobs/idempotency-cleanup";

let bootstrapped = false;

export function bootstrapCronRegistry(): void {
  if (bootstrapped) return;
  registerJob(heartbeatJob);
  registerJob(supplierSyncJob);
  registerJob(opsWatchJob);
  registerJob(fefoRecheckJob);
  registerJob(secretRotationCleanupJob);
  registerJob(pricingFeedPullJob);
  registerJob(outboxSweepJob);
  registerJob(backupDailyJob);
  registerJob(idempotencyCleanupJob);
  bootstrapped = true;
}

bootstrapCronRegistry();

export async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  bootstrapCronRegistry();
  const job = getJobByCron(controller.cron);
  if (!job) {
    console.error(JSON.stringify({ level: "error", error_code: "GH-CRON-001", detail: "no_job_for_cron", cron: controller.cron }));
    return;
  }
  const result = await runJob(job, env, ctx, "cron");
  console.log(JSON.stringify({ level: result.status === "failed" ? "error" : "info", event: "cron.run", ...result }));
}

export { allJobs, getJobByCron, registerJob };
export { runJob };
