/**
 * Betriebs-Wächter: prüft alle 15 Minuten, was sich aus der Datenbank sicher
 * erkennen lässt, und meldet ÄNDERUNGEN der Alarmlage (neu, behoben) per Mail
 * an `OPS_ALERT_EMAIL`. Kein Alarm wird je Takt wiederholt — eine Mail im
 * Viertelstundentakt liest niemand mehr.
 *
 * Bewusst NICHT hier (braucht Metriken, die nicht in D1 liegen): Fehlerbudget,
 * p99-Latenz, Anmeldefehler-Spitzen. Die bleiben in monitoring/alerts.json
 * als Ziel und gehören zu Workers Observability.
 *
 * Kein Alarmtext enthält Kundendaten oder Geheimnisse — nur Zähler, Job-Namen
 * und Tenant-IDs.
 */
import type { Env } from "../env";
import { email } from "../auth/email";
import { sha256Hex } from "../lib/crypto";

export interface Alarm { id: string; severity: "critical" | "warning"; text: string }

const H = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function evaluate(env: Env): Promise<Alarm[]> {
  const out: Alarm[] = [];
  const q = async <T>(sql: string, ...b: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...b).all<T>()).results ?? [];

  for (const r of await q<{ job_id: string }>("SELECT job_id FROM cron_job_state WHERE paused = 1 ORDER BY job_id")) {
    out.push({ id: `cron_paused:${r.job_id}`, severity: "warning", text: `Zeitplan-Job ${r.job_id} ist nach wiederholten Fehlern pausiert.` });
  }

  const backupRuns = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(CASE WHEN status = 'success' THEN started_at END) AS last FROM cron_runs WHERE job_id = 'backup-daily'")
    .first<{ n: number; last: string | null }>();
  if ((backupRuns?.n ?? 0) > 0 && (!backupRuns?.last || backupRuns.last < ago(26 * H))) {
    out.push({ id: "backup_stale", severity: "critical", text: `Kein erfolgreiches Tages-Backup seit ${backupRuns?.last ?? "Beginn"}.` });
  }

  const lag = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox_events WHERE status IN ('pending', 'retrying') AND created_at < ?")
    .bind(ago(H)).first<{ n: number; oldest: string | null }>();
  if (lag && lag.n > 0) out.push({ id: "outbox_lag", severity: "warning", text: `${lag.n} Ereignisse warten länger als 1 h auf Zustellung (ältestes ${lag.oldest}).` });

  const dead = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'dead_letter' AND created_at > ?").bind(ago(24 * H)).first<{ n: number }>();
  if (dead && dead.n > 0) out.push({ id: "outbox_dead_letter", severity: "warning", text: `${dead.n} Ereignisse in den letzten 24 h endgültig nicht zustellbar.` });

  for (const r of await q<{ tenant_id: string; module_id: string }>("SELECT tenant_id, module_id FROM tenant_modules WHERE enabled = 1 AND status = 'error' ORDER BY tenant_id, module_id")) {
    out.push({ id: `module_error:${r.tenant_id}:${r.module_id}`, severity: "warning", text: `Lieferanten-Modul ${r.module_id} meldet einen Verbindungsfehler (Tenant ${r.tenant_id}).` });
  }

  for (const r of await q<{ tenant_id: string; connection: string; last: string | null }>(
    `SELECT m.tenant_id, s.connection, MAX(s.synced_at) AS last FROM tenant_modules m
       JOIN supplier_sync_state s ON s.tenant_id = m.tenant_id AND s.provider = m.module_id
      WHERE m.module_id = 'floriday' AND m.enabled = 1 GROUP BY m.tenant_id, s.connection HAVING last IS NULL OR last < ?`, ago(2 * H))) {
    out.push({ id: `supplier_sync_stale:${r.tenant_id}:${r.connection}`, severity: "warning", text: `Floriday-Abgleich seit über 2 h ohne Erfolg (Tenant ${r.tenant_id}).` });
  }

  for (const r of await q<{ tenant_id: string; n: number }>("SELECT tenant_id, COUNT(*) AS n FROM supplier_purchase_requests WHERE status = 'cancel_requested' GROUP BY tenant_id ORDER BY tenant_id")) {
    out.push({ id: `purchase_cancel_requested:${r.tenant_id}`, severity: "warning", text: `${r.n} Einkaufsbestellung(en) beim Lieferanten müssen storniert werden (Tenant ${r.tenant_id}).` });
  }
  for (const r of await q<{ tenant_id: string; n: number }>("SELECT tenant_id, COUNT(*) AS n FROM supplier_purchase_requests WHERE status = 'open' AND created_at < ? GROUP BY tenant_id ORDER BY tenant_id", ago(12 * H))) {
    out.push({ id: `purchase_open_stale:${r.tenant_id}`, severity: "warning", text: `${r.n} Einkaufsanforderung(en) seit über 12 h nicht gesendet (Tenant ${r.tenant_id}).` });
  }
  return out;
}

export const STATE_KEY = "ops:alarms:v1";

/** Alarmlage bewerten, mit der letzten vergleichen, bei Änderung melden. */
export async function watch(env: Env): Promise<{ firing: Alarm[]; neu: Alarm[]; behoben: string[]; gemeldet: boolean }> {
  const firing = await evaluate(env);
  let previous: Record<string, string> = {};
  try { previous = (await env.KV.get<Record<string, string>>(STATE_KEY, "json")) ?? {}; } catch { /* KV weg: alles gilt als neu */ }
  const current = Object.fromEntries(firing.map((a) => [a.id, a.text]));
  const neu = firing.filter((a) => !(a.id in previous));
  const behoben = Object.keys(previous).filter((id) => !(id in current));
  let gemeldet = false;
  if (neu.length || behoben.length) {
    const mailer = email(env);
    const to = env.OPS_ALERT_EMAIL;
    if (mailer && to) {
      const lines = [
        ...neu.map((a) => `NEU [${a.severity}] ${a.text}`),
        ...behoben.map((id) => `BEHOBEN ${previous[id] ?? id}`),
        "", `Aktuell offen: ${firing.length}`, `Umgebung: ${env.ENVIRONMENT}`,
      ];
      const crit = neu.some((a) => a.severity === "critical");
      await mailer.send({ to, subject: `[Grosshandel ${env.ENVIRONMENT}] ${crit ? "KRITISCH: " : ""}${neu.length} neu, ${behoben.length} behoben`, text: lines.join("\n") });
      gemeldet = true;
    }
    console.log(JSON.stringify({ event: "ops.alarms_changed", neu: neu.map((a) => a.id), behoben, firing: firing.length, gemeldet }));
    try { await env.KV.put(STATE_KEY, JSON.stringify(current), { expirationTtl: 7 * 24 * 3600 }); } catch { /* nächster Lauf meldet erneut */ }
  }
  return { firing, neu, behoben, gemeldet };
}

/** Abdruck der Alarmlage, z. B. für /admin/ops/alarms. */
export async function fingerprint(firing: Alarm[]): Promise<string> {
  return (await sha256Hex(firing.map((a) => a.id).sort().join("|"))).slice(0, 12);
}
