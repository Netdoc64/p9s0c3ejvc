import { describe, expect, it } from "vitest";
import { SLOS, getSLO } from "../../src/observability/slos";

describe("slos definitions", () => {
  it("contains the 5 SLOs from build-plan", () => {
    const ids = SLOS.map((s) => s.id).sort();
    expect(ids).toEqual([
      "api_availability_30d",
      "api_p99_latency",
      "auth_p99_latency",
      "stock_reserve_p99",
      "webhook_delivery_within_1h",
    ]);
  });

  it("api_availability_30d has 99.9% target", () => {
    const slo = getSLO("api_availability_30d");
    expect(slo?.target).toBe(0.999);
    expect(slo?.window_days).toBe(30);
  });

  it("every SLO has burn-rate thresholds", () => {
    for (const s of SLOS) {
      expect(s.alert_at_burn_rate.warning).toBeGreaterThan(0);
      expect(s.alert_at_burn_rate.critical).toBeGreaterThan(s.alert_at_burn_rate.warning);
    }
  });
});
