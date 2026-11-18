import { describe, expect, it } from "vitest";
import { SLOS } from "../../src/observability/slos";

declare global {
  // Vite-Typen sind im Projekt nicht eingebunden -> schmale lokale Signatur.
  interface ImportMeta { glob(pattern: string, opts: object): unknown }
}

// Der Test laeuft im Workers-Pool (kein fs) -> Quelltexte per Vite ?raw einlesen.

const sources = import.meta.glob("/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrations = import.meta.glob("/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const runbooks = import.meta.glob("/docs/runbooks/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const alertsRaw = Object.values(
  import.meta.glob("/monitoring/alerts.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

interface Alert { id: string; slo_ref?: string; condition: string; runbook: string }
const alerts = (JSON.parse(alertsRaw) as { alerts: Alert[] }).alerts;

const METRICS_FILE = "/src/observability/metrics.ts";
const codeFiles = Object.entries(sources).filter(([p]) => p !== METRICS_FILE);
const allCode = codeFiles.map(([, s]) => s).join("\n");
const compact = allCode.split(/[ \t\r\n]+/).join("");
function emitted(name: string): boolean {
  const quoted = ["\"", "'", "`"].map((q) => q + name + q);
  return ["counter", "histogram", "gauge"].some((fn) => quoted.some((q) => compact.includes(fn + "(" + q)));
}

/** Metrik-Namen = punktgetrennte Bezeichner in der Bedingung (ohne Tabelle.Spalte-Bezuege). */
function metricNames(cond: string): string[] {
  return (cond.match(/\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/g) ?? []).filter((n) => n !== "cron_job_state.paused");
}

describe("monitoring/alerts.json gegen den Code", () => {
  it("liest Alerts und Runbooks ein", () => {
    expect(alerts.length).toBeGreaterThan(0);
    expect(Object.keys(runbooks).length).toBeGreaterThan(0);
  });

  it("jede Metrik in einer condition wird im Code emittiert", () => {
    const missing: string[] = [];
    for (const a of alerts) for (const m of metricNames(a.condition)) if (!emitted(m)) missing.push(`${a.id}: ${m}`);
    expect(missing).toEqual([]);
  });

  it("burn_rate-Alerts und slo_ref zeigen auf bekannte SLOs", () => {
    const ids = new Set(SLOS.map((s) => s.id));
    for (const a of alerts) {
      if (a.slo_ref) expect(ids.has(a.slo_ref), `${a.id}: slo_ref ${a.slo_ref}`).toBe(true);
      if (/burn_rate\(/.test(a.condition)) expect(a.slo_ref, `${a.id}: burn_rate braucht slo_ref`).toBeTruthy();
    }
  });

  it("GH-AUTH-Codes, cron_job_state und X-Idempotency-Warning existieren", () => {
    for (const a of alerts) {
      if (/GH-AUTH-/.test(a.condition)) expect(sources["/src/errors/catalog.ts"]).toMatch(/"GH-AUTH-001"/);
      if (/cron_job_state\.paused/.test(a.condition)) {
        const sql = Object.values(migrations).join("\n");
        expect(sql).toMatch(/cron_job_state/);
        expect(sql).toMatch(/\bpaused\b/);
      }
      const hdr = a.condition.match(/X-[A-Za-z-]+Warning/)?.[0];
      if (hdr) expect(allCode, `${a.id}: ${hdr}`).toContain(hdr);
    }
  });

  it("jedes runbook-Feld zeigt auf eine existierende Datei", () => {
    for (const a of alerts) expect(runbooks["/" + a.runbook], `${a.id}: ${a.runbook}`).toBeTypeOf("string");
  });

  it("jedes Runbook wird von mindestens einem Alert referenziert", () => {
    const referenced = new Set(alerts.map((a) => "/" + a.runbook));
    const orphans = Object.keys(runbooks).filter((p) => !referenced.has(p));
    expect(orphans).toEqual([]);
  });

  it("emittierte Metriken tragen keine verbotenen Labels", () => {
    expect(allCode).not.toMatch(/(counter|histogram|gauge)\([^)]*\b(customer_id|order_id)\b/);
  });
});
