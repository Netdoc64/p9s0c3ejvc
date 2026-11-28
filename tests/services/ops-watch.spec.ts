import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEmailAdapter, setEmailAdapter } from "../../src/auth/email";
import { evaluate, watch, STATE_KEY } from "../../src/ops/watch";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";

let t: SeededTenant;
let mails: Array<{ to: string; subject: string; text: string }>;
const E = () => ({ ...env, OPS_ALERT_EMAIL: "ops@betrieb.example" }) as never;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(async () => {
  t = await seedTenant({ slug: "ops-a" });
  mails = [];
  setEmailAdapter({ async send(m) { mails.push({ to: m.to, subject: m.subject, text: m.text }); } });
  await env.KV.delete(STATE_KEY);
});
afterEach(async () => {
  resetEmailAdapter();
  await env.DB.prepare("DELETE FROM cron_job_state").run();
  await env.DB.prepare("DELETE FROM cron_runs").run();
  await env.DB.prepare("DELETE FROM outbox_events").run();
  await clearTenants();
});

describe("Betriebs-Wächter", () => {
  it("ruhig: keine Alarme, keine Mail", async () => {
    expect(await evaluate(E())).toEqual([]);
    expect((await watch(E())).gemeldet).toBe(false);
    expect(mails).toHaveLength(0);
  });

  it("erkennt pausierte Jobs, altes Backup, Outbox-Stau, Modulfehler und Einkaufsaufgaben", async () => {
    await env.DB.prepare("INSERT INTO cron_job_state (job_id, paused) VALUES ('supplier-sync', 1)").run();
    await env.DB.prepare("INSERT INTO cron_runs (id, job_id, started_at, status) VALUES ('r1', 'backup-daily', ?, 'success')").bind(iso(30 * 3_600_000)).run();
    await env.DB.prepare("INSERT INTO outbox_events (id, tenant_id, topic, aggregate_id, payload, status, created_at) VALUES ('e1', ?, 't', 'a', '{}', 'pending', ?)")
      .bind(t.tenant_id, iso(2 * 3_600_000)).run();
    await env.DB.prepare("INSERT INTO tenant_modules (tenant_id, module_id, enabled, status, updated_at) VALUES (?, 'floriday', 1, 'error', ?)").bind(t.tenant_id, iso(0)).run();
    await env.DB.prepare(`INSERT INTO supplier_purchase_requests (id, tenant_id, order_id, line_no, sku_id, provider, connection, source_ref, qty, source_qty, cost_cents, status, created_at, updated_at)
      VALUES ('pr1', ?, 'ord_1', 1, 'sku_1', 'file-import', 'l', 'R', 1, 1, 10, 'cancel_requested', ?, ?)`).bind(t.tenant_id, iso(0), iso(0)).run();

    const ids = (await evaluate(E())).map((a) => a.id.split(":")[0]).sort();
    expect(ids).toEqual(["backup_stale", "cron_paused", "module_error", "outbox_lag", "purchase_cancel_requested"]);
    const crit = (await evaluate(E())).find((a) => a.id === "backup_stale");
    expect(crit?.severity).toBe("critical");
  });

  it("meldet nur Änderungen: neu, dann still, dann behoben", async () => {
    await env.DB.prepare("INSERT INTO cron_job_state (job_id, paused) VALUES ('backup-daily', 1)").run();
    const r1 = await watch(E());
    expect(r1.gemeldet).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe("ops@betrieb.example");
    expect(mails[0]?.text).toContain("NEU [warning]");

    await watch(E());
    expect(mails).toHaveLength(1);

    await env.DB.prepare("UPDATE cron_job_state SET paused = 0").run();
    await watch(E());
    expect(mails).toHaveLength(2);
    expect(mails[1]?.text).toContain("BEHOBEN");
  });

  it("ohne OPS_ALERT_EMAIL wird nur protokolliert", async () => {
    await env.DB.prepare("INSERT INTO cron_job_state (job_id, paused) VALUES ('x', 1)").run();
    const r = await watch({ ...env, OPS_ALERT_EMAIL: undefined } as never);
    expect(r.gemeldet).toBe(false);
    expect(mails).toHaveLength(0);
  });
});
