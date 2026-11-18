import type { OrderDoc } from "../schemas/order";

export interface GateResult {
  gate_id: string;
  passed: boolean;
  detail?: string;
  code?: string;
}

export interface GateContext {
  customer: { id: string; blocked: number; credit_limit_cents: number | null; vat_status: string };
  /** Summe offener Bestellungen + diese Bestellung in Tenant-Currency. */
  outstanding_total_cents: number;
}

/**
 * Deterministische Gate-Auswertung. Pure Funktion — Daten werden injiziert.
 */
export function evaluateGates(doc: OrderDoc, ctx: GateContext): GateResult[] {
  const gates: GateResult[] = [];

  // Customer-blocked
  gates.push({
    gate_id: "customer_active",
    passed: ctx.customer.blocked === 0,
    code: ctx.customer.blocked === 0 ? undefined : "GH-CUST-003",
    detail: ctx.customer.blocked === 0 ? undefined : "customer is blocked",
  });

  // Credit-Limit
  if (ctx.customer.credit_limit_cents !== null) {
    const exceed = ctx.outstanding_total_cents + doc.totals.total_cents > ctx.customer.credit_limit_cents;
    gates.push({
      gate_id: "credit_limit",
      passed: !exceed,
      code: exceed ? "GH-CUST-004" : undefined,
      detail: exceed ? `outstanding ${ctx.outstanding_total_cents} + order ${doc.totals.total_cents} > limit ${ctx.customer.credit_limit_cents}` : undefined,
    });
  }

  // Mind. eine Line
  gates.push({
    gate_id: "non_empty",
    passed: doc.lines.length > 0,
    code: doc.lines.length > 0 ? undefined : "GH-INPUT-001",
    detail: doc.lines.length > 0 ? undefined : "order has no lines",
  });

  return gates;
}

export function blockingFromGates(gates: GateResult[]): Array<{ code: string; detail?: string; gate_id: string }> {
  return gates
    .filter((g) => !g.passed)
    .map((g) => ({ code: g.code ?? "GH-ORDER-003", detail: g.detail, gate_id: g.gate_id }));
}
