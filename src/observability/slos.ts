/**
 * SLO-Definitionen als Code. Quelle der Wahrheit für Alerting + Dashboards.
 * Werte aus build-plan.json#cross_cutting.slo.
 */

export interface SLO {
  id: string;
  description: string;
  sli: string; // Service Level Indicator (Beschreibung der Messung)
  target: number; // 0..1 (z.B. 0.999)
  window_days: number;
  alert_at_burn_rate: { warning: number; critical: number }; // Errorbudget-Burn Multiplikatoren
}

export const SLOS: ReadonlyArray<SLO> = [
  {
    id: "api_availability_30d",
    description: "API responds with non-5xx for valid requests",
    sli: "successful_requests / total_requests",
    target: 0.999,
    window_days: 30,
    alert_at_burn_rate: { warning: 1, critical: 14.4 },
  },
  {
    id: "api_p99_latency",
    description: "p99 Latenz für hot-path Endpoints",
    sli: "p99(duration_ms) < 500",
    target: 0.99,
    window_days: 30,
    alert_at_burn_rate: { warning: 1, critical: 14.4 },
  },
  {
    id: "auth_p99_latency",
    description: "p99 Latenz für Auth-Middleware",
    sli: "p99(auth.duration_ms) < 200",
    target: 0.99,
    window_days: 30,
    alert_at_burn_rate: { warning: 1, critical: 14.4 },
  },
  {
    id: "stock_reserve_p99",
    description: "Stock-DO reserve p99 < 100ms",
    sli: "p99(stock.reserve.duration_ms) < 100",
    target: 0.99,
    window_days: 30,
    alert_at_burn_rate: { warning: 1, critical: 14.4 },
  },
  {
    id: "webhook_delivery_within_1h",
    description: "Webhook-Delivery binnen 1h nach State-Change",
    sli: "delivered_within_1h / total_emitted",
    target: 0.99,
    window_days: 30,
    alert_at_burn_rate: { warning: 1, critical: 14.4 },
  },
];

export function getSLO(id: string): SLO | undefined {
  return SLOS.find((s) => s.id === id);
}
