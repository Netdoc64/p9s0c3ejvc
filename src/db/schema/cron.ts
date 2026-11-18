import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const cron_runs = sqliteTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    job_id: text("job_id").notNull(),
    started_at: text("started_at").notNull(),
    ended_at: text("ended_at"),
    status: text("status").notNull(),
    duration_ms: integer("duration_ms"),
    error_code: text("error_code"),
    error_detail: text("error_detail"),
    trigger: text("trigger").notNull().default("cron"),
  },
  (t) => ({ by_job: index("idx_cron_runs_job_id").on(t.job_id, t.started_at) }),
);

export const cron_job_state = sqliteTable("cron_job_state", {
  job_id: text("job_id").primaryKey(),
  paused: integer("paused").notNull().default(0),
  consecutive_failures: integer("consecutive_failures").notNull().default(0),
  last_run_at: text("last_run_at"),
  last_success_at: text("last_success_at"),
});

export type CronRun = typeof cron_runs.$inferSelect;
export type CronJobState = typeof cron_job_state.$inferSelect;
