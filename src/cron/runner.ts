import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { cron_job_state, cron_runs } from "../db/schema/cron";
import { newId } from "../lib/ids";
import { isCodedError } from "../errors/catalog";
import type { CronJob, CronJobContext } from "./registry";

const DEFAULT_LOCK_TTL_SEC = 300;
const DEFAULT_PAUSE_AFTER = 3;

export interface RunResult {
  job_id: string;
  run_id: string;
  status: "success" | "failed" | "skipped_locked" | "skipped_paused";
  duration_ms?: number;
  error_code?: string;
  error_detail?: string;
}

export async function runJob(
  job: CronJob,
  env: Env,
  ctx: ExecutionContext,
  trigger: "cron" | "manual" | "queue" = "cron",
): Promise<RunResult> {
  const db = getDb(env.DB);
  const run_id = newId("event");
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  // Pause-Check
  const stateRow = (await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, job.id)).limit(1))[0];
  if (stateRow?.paused === 1) {
    return { job_id: job.id, run_id, status: "skipped_paused" };
  }

  // Lock acquire via CRON_LOCK_DO (#C-004: dead code removed, optional binding bleibt
  // für Tests-Mock — production hat es required gebunden via wrangler.toml).
  const lockNs = env.CRON_LOCK_DO;
  const holder_id = run_id;
  let lockAcquired = false;
  if (lockNs) {
    const stub = lockNs.get(lockNs.idFromName(`cron:${job.id}`));
    const res = await stub.fetch("https://lock.local/acquire", {
      method: "POST",
      body: JSON.stringify({ holder_id, ttl_sec: job.lock_ttl_sec ?? DEFAULT_LOCK_TTL_SEC }),
      headers: { "Content-Type": "application/json" },
    });
    lockAcquired = res.status === 200;
    if (!lockAcquired) {
      return { job_id: job.id, run_id, status: "skipped_locked" };
    }
  }

  await db.insert(cron_runs).values({
    id: run_id,
    job_id: job.id,
    started_at: startedAt,
    status: "running",
    trigger,
  });

  const jobCtx: CronJobContext = { env, ctx, run_id, trigger };
  let result: RunResult;
  try {
    await job.handler(jobCtx);
    const duration_ms = Math.round(performance.now() - t0);
    const endedAt = new Date().toISOString();
    await db.update(cron_runs).set({ ended_at: endedAt, status: "success", duration_ms }).where(eq(cron_runs.id, run_id));
    await upsertJobState(db, job.id, { last_run_at: endedAt, last_success_at: endedAt, consecutive_failures: 0 });
    result = { job_id: job.id, run_id, status: "success", duration_ms };
  } catch (err) {
    const duration_ms = Math.round(performance.now() - t0);
    const endedAt = new Date().toISOString();
    const code = isCodedError(err) ? err.code : "GH-CRON-001";
    const detail = err instanceof Error ? err.message : String(err);
    await db.update(cron_runs).set({ ended_at: endedAt, status: "failed", duration_ms, error_code: code, error_detail: detail }).where(eq(cron_runs.id, run_id));
    const next = await bumpFailures(db, job.id, endedAt);
    if (job.pause_after_failures !== false && next >= (job.pause_after_failures ?? DEFAULT_PAUSE_AFTER)) {
      await pauseJob(db, job.id);
    }
    result = { job_id: job.id, run_id, status: "failed", duration_ms, error_code: code, error_detail: detail };
  } finally {
    if (lockNs && lockAcquired) {
      try {
        const releaseStub = lockNs.get(lockNs.idFromName(`cron:${job.id}`));
        await releaseStub.fetch("https://lock.local/release", { method: "POST", body: JSON.stringify({ holder_id }), headers: { "Content-Type": "application/json" } });
      } catch {
        // best-effort
      }
    }
  }
  return result;
}

async function upsertJobState(db: ReturnType<typeof getDb>, job_id: string, patch: Partial<typeof cron_job_state.$inferInsert>): Promise<void> {
  const existing = (await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, job_id)).limit(1))[0];
  if (existing) {
    await db.update(cron_job_state).set(patch).where(eq(cron_job_state.job_id, job_id));
  } else {
    await db.insert(cron_job_state).values({ job_id, ...patch });
  }
}

async function bumpFailures(db: ReturnType<typeof getDb>, job_id: string, ts: string): Promise<number> {
  const existing = (await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, job_id)).limit(1))[0];
  const next = (existing?.consecutive_failures ?? 0) + 1;
  if (existing) {
    await db.update(cron_job_state).set({ consecutive_failures: next, last_run_at: ts }).where(eq(cron_job_state.job_id, job_id));
  } else {
    await db.insert(cron_job_state).values({ job_id, consecutive_failures: next, last_run_at: ts });
  }
  return next;
}

async function pauseJob(db: ReturnType<typeof getDb>, job_id: string): Promise<void> {
  await db.update(cron_job_state).set({ paused: 1 }).where(eq(cron_job_state.job_id, job_id));
}

export async function manualResume(env: Env, job_id: string): Promise<void> {
  const db = getDb(env.DB);
  await db.update(cron_job_state).set({ paused: 0, consecutive_failures: 0 }).where(eq(cron_job_state.job_id, job_id));
}
