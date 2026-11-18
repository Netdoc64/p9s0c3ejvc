import type { Env } from "../env";

export interface CronJobContext {
  env: Env;
  ctx: ExecutionContext;
  run_id: string;
  trigger: "cron" | "manual" | "queue";
}

export interface CronJob {
  id: string;
  cron: string; // CF-Cron-Pattern
  description: string;
  handler: (ctx: CronJobContext) => Promise<void>;
  /** Lock-TTL in Sekunden (Default 300). Wenn Job länger läuft → Lock fällt, anderer Trigger könnte parallel nehmen. */
  lock_ttl_sec?: number;
  /** Auto-Pause nach n consecutive failures (Default 3, false = nie pausieren). */
  pause_after_failures?: number | false;
}

const REGISTRY = new Map<string, CronJob>();

export function registerJob(job: CronJob): void {
  if (REGISTRY.has(job.id)) {
    throw new Error(`cron job duplicate id: ${job.id}`);
  }
  REGISTRY.set(job.id, job);
}

export function getJob(id: string): CronJob | undefined {
  return REGISTRY.get(id);
}

export function getJobByCron(cron: string): CronJob | undefined {
  for (const job of REGISTRY.values()) {
    if (job.cron === cron) return job;
  }
  return undefined;
}

export function allJobs(): CronJob[] {
  return [...REGISTRY.values()];
}

export function clearRegistry(): void {
  REGISTRY.clear();
}
