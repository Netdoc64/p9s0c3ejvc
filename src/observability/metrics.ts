/**
 * Lightweight metrics interface — ohne externen Sink in v1.
 * Emittiert Metric-Records als strukturierte Logs (Workers-Logs sammelt sie).
 * Plan-Revision-Kandidat: nativer Counter via Workers Analytics Engine.
 */

export type MetricKind = "counter" | "histogram" | "gauge";

export interface MetricRecord {
  kind: MetricKind;
  name: string;
  value: number;
  labels?: Record<string, string | number | boolean>;
  ts: string;
}

const FORBIDDEN_LABEL_KEYS = new Set(["customer_id", "order_id", "request_id", "email"]);

function emit(rec: MetricRecord): void {
  // strukturiert nach console; CF Logpush sammelt JSON und kann nach metrics-name filtern
  console.log(JSON.stringify({ event: "metric", ...rec }));
}

function safeLabels(labels?: Record<string, string | number | boolean>): Record<string, string | number | boolean> | undefined {
  if (!labels) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (FORBIDDEN_LABEL_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function counter(name: string, value = 1, labels?: Record<string, string | number | boolean>): void {
  emit({ kind: "counter", name, value, labels: safeLabels(labels), ts: new Date().toISOString() });
}

export function histogram(name: string, value: number, labels?: Record<string, string | number | boolean>): void {
  emit({ kind: "histogram", name, value, labels: safeLabels(labels), ts: new Date().toISOString() });
}

export function gauge(name: string, value: number, labels?: Record<string, string | number | boolean>): void {
  emit({ kind: "gauge", name, value, labels: safeLabels(labels), ts: new Date().toISOString() });
}

export const metrics = { counter, histogram, gauge };
