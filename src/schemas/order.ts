import { z } from "zod";

export const ORDER_SCHEMA_VERSION = "order-document/1.0";

export const OrderStateSchema = z.enum([
  "draft",
  "resolving",
  "awaiting_confirmation",
  "confirmed",
  "shipped",
  "invoiced",
  "paid",
  "cancelled",
  "on_hold",
]);
export type OrderState = z.infer<typeof OrderStateSchema>;

export const StepTypeSchema = z.enum([
  "resolve",
  "validate_gates",
  "reserve_stock",
  "commit_stock",
  "release_stock",
  "emit_event",
  "await_confirmation",
  "state_transition",
  "audit_append",
  "user_interaction",
  "external_call",
  "queue_message",
  "webhook",
  "generate_invoice",
]);
export type StepType = z.infer<typeof StepTypeSchema>;

export const StepSchema = z.object({
  id: z.string(),
  type: StepTypeSchema,
  args: z.record(z.string(), z.unknown()).default({}),
});
export type Step = z.infer<typeof StepSchema>;

export const ExecutedStepSchema = z.object({
  step_id: z.string(),
  type: StepTypeSchema,
  started_at: z.string(),
  ended_at: z.string(),
  decision_reason: z.string().optional(),
  result_summary: z.record(z.string(), z.unknown()).optional(),
  error_code: z.string().optional(),
});
export type ExecutedStep = z.infer<typeof ExecutedStepSchema>;

export const PlanSchema = z.object({
  next_steps: z.array(StepSchema).default([]),
  executed_steps: z.array(ExecutedStepSchema).default([]),
});

export const IssuesSchema = z.object({
  blocking: z.array(z.object({
    code: z.string(),
    detail: z.string().optional(),
    gate_id: z.string().optional(),
    line_no: z.number().int().optional(),
  })).default([]),
  warnings: z.array(z.object({
    code: z.string(),
    detail: z.string().optional(),
  })).default([]),
});

export const StateSchema = z.object({
  current: OrderStateSchema,
  history: z.array(z.object({
    from: OrderStateSchema.nullable(),
    to: OrderStateSchema,
    by_step_id: z.string().optional(),
    ts: z.string(),
  })).default([]),
});

// qty.max (#V-003): verhindert Number-Overflow bei subtotal=qty*unit_price_cents.
export const LineInputSchema = z.object({
  sku_id: z.string().startsWith("sku_"),
  qty: z.number().int().positive().max(100_000),
  warehouse_id: z.string().startsWith("wh_").optional(),
}).strict();

export const LineSchema = LineInputSchema.extend({
  line_no: z.number().int().positive(),
  unit_price_cents: z.number().int().nullable().optional(),
  tax_scheme: z.string().nullable().optional(),
  tax_rate_pct: z.number().nullable().optional(),
  tax_rule_id: z.string().nullable().optional(),
  line_total_cents: z.number().int().nullable().optional(),
  reservation_id: z.string().nullable().optional(),
  resolution: z.record(z.string(), z.unknown()).default({}),
});

export const OrderDocSchema = z.object({
  meta: z.object({
    schema_version: z.literal(ORDER_SCHEMA_VERSION),
    doc_type: z.literal("order"),
    id: z.string().startsWith("ord_"),
    tenant_id: z.string().startsWith("t_"),
    parent_order_id: z.string().nullable().optional(),
  }),
  customer_id: z.string().startsWith("cust_"),
  customer_snapshot: z.record(z.string(), z.unknown()).default({}),
  source: z.record(z.string(), z.unknown()).default({}),
  actor: z.record(z.string(), z.unknown()).default({}),
  lines: z.array(LineSchema).default([]),
  totals: z.object({
    subtotal_cents: z.number().int().default(0),
    tax_cents: z.number().int().default(0),
    total_cents: z.number().int().default(0),
    currency: z.string(),
    fx_snapshot: z.record(z.string(), z.unknown()).optional(),
  }),
  state: StateSchema,
  plan: PlanSchema,
  external_refs: z.record(z.string(), z.unknown()).default({}),
  issues: IssuesSchema,
  gates_log: z.record(z.string(), z.unknown()).default({}),
  audit: z.record(z.string(), z.unknown()).default({}),
});
export type OrderDoc = z.infer<typeof OrderDocSchema>;

// lines.max (#V-004) + strict (#V-001) + source/actor size-limit (#V-002)
export const CreateOrderRequestSchema = z.object({
  customer_id: z.string().startsWith("cust_"),
  lines: z.array(LineInputSchema).min(1).max(500),
  notes: z.string().max(500).optional(),
  source: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 4096, "source too large").optional(),
  actor: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 4096, "actor too large").optional(),
}).strict();
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/** Allowed state transitions. */
export const ALLOWED_TRANSITIONS: Record<OrderState, OrderState[]> = {
  draft: ["resolving", "on_hold", "cancelled"],
  resolving: ["awaiting_confirmation", "on_hold", "cancelled"],
  awaiting_confirmation: ["confirmed", "on_hold", "cancelled"],
  confirmed: ["shipped", "cancelled", "on_hold"],
  shipped: ["invoiced", "cancelled"],
  invoiced: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
  on_hold: ["resolving", "awaiting_confirmation", "cancelled"],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
