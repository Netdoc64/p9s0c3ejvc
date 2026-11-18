import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { cron_job_state, cron_runs } from "../../src/db/schema/cron";
import { allJobs, clearRegistry, registerJob } from "../../src/cron/registry";
import { runJob } from "../../src/cron/runner";

afterEach(async () => {
  const db = getDb(env.DB);
  await db.delete(cron_runs);
  await db.delete(cron_job_state);
});

describe("cron runner", () => {
  it("success-Run schreibt cron_runs.status='success' und reset failures", async () => {
    let calls = 0;
    const job = {
      id: "test-success",
      cron: "* * * * *",
      description: "test",
      handler: async () => {
        calls += 1;
      },
    };
    const ctx = createExecutionContext();
    const r = await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe("success");
    expect(calls).toBe(1);

    const db = getDb(env.DB);
    const runs = await db.select().from(cron_runs).where(eq(cron_runs.job_id, "test-success"));
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe("success");

    const state = await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, "test-success"));
    expect(state[0]?.consecutive_failures).toBe(0);
    expect(state[0]?.last_success_at).toBeTruthy();
  });

  it("failure-Run schreibt status='failed' und bumpt consecutive_failures", async () => {
    const job = {
      id: "test-fail",
      cron: "* * * * *",
      description: "always fails",
      handler: async () => {
        throw new Error("kapow");
      },
    };
    const ctx = createExecutionContext();
    const r = await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe("failed");
    expect(r.error_code).toBe("GH-CRON-001");

    const db = getDb(env.DB);
    const state = await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, "test-fail"));
    expect(state[0]?.consecutive_failures).toBe(1);
  });

  it("nach 3 consecutive failures wird Job paused", async () => {
    const job = {
      id: "test-pause",
      cron: "* * * * *",
      description: "fails until paused",
      pause_after_failures: 3 as const,
      handler: async () => {
        throw new Error("nope");
      },
    };
    const ctx = createExecutionContext();
    await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await waitOnExecutionContext(ctx);

    const db = getDb(env.DB);
    const state = await db.select().from(cron_job_state).where(eq(cron_job_state.job_id, "test-pause"));
    expect(state[0]?.paused).toBe(1);

    // Nächster Lauf wird übersprungen
    const r = await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    expect(r.status).toBe("skipped_paused");
  });

  it("Idempotenz: zwei manuelle Runs führen Handler zweimal aus, beide erscheinen in cron_runs", async () => {
    let calls = 0;
    const job = {
      id: "test-idempotent",
      cron: "* * * * *",
      description: "counts",
      handler: async () => {
        calls += 1;
      },
    };
    const ctx = createExecutionContext();
    await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await runJob(job, { ...env, CRON_LOCK_DO: undefined } as unknown as import("../../src/env").Env, ctx, "manual");
    await waitOnExecutionContext(ctx);

    expect(calls).toBe(2);
    const db = getDb(env.DB);
    const runs = await db.select().from(cron_runs).where(eq(cron_runs.job_id, "test-idempotent"));
    expect(runs.length).toBe(2);
  });
});

describe("cron registry", () => {
  it("heartbeatJob ist registriert", () => {
    const jobs = allJobs().map((j) => j.id);
    expect(jobs).toContain("heartbeat");
  });

  it("registerJob wirft bei Duplikat-ID", () => {
    expect(() =>
      registerJob({
        id: "heartbeat",
        cron: "* * * * *",
        description: "dup",
        handler: async () => {},
      }),
    ).toThrow();
  });

  // Cleanup für andere Tests, die clearRegistry brauchen
  it("clearRegistry leert die Map", () => {
    clearRegistry();
    expect(allJobs().length).toBe(0);
    // Re-bootstrap
    void import("../../src/cron").then((m) => m.bootstrapCronRegistry());
  });
});
