import { z } from "zod";

export const ReturnRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
const quantity = z.number().int().min(1).max(100_000);
const warehouse = ReturnRef.refine((id) => id.startsWith("wh_"));
const tenant = ReturnRef.refine((id) => id.startsWith("t_"));
const command_id = ReturnRef;
const line_id = ReturnRef;
const supplierRoute = z.array(z.strictObject({
  tenant_id: tenant,
  purchase_line_ref: ReturnRef,
})).min(1).max(8).refine((hops) => new Set(hops.map((hop) => hop.tenant_id)).size === hops.length);

export const DeliveryInput = z.strictObject({
  command_id,
  positions: z.array(z.strictObject({
    delivery_line_id: ReturnRef,
    order_line_no: z.number().int().min(1).max(500),
    qty: quantity,
    batch_ref: ReturnRef.optional(),
    suppliers: supplierRoute.optional(),
  })).min(1).max(50),
});

export const CreateReturnInput = z.strictObject({
  command_id,
  kind: z.enum(["return", "complaint"]),
  reason: z.string().trim().min(1).max(500),
  evidence_refs: z.array(ReturnRef).max(10).default([]),
  positions: z.array(z.strictObject({ delivery_line_id: ReturnRef, qty: quantity })).min(1).max(50),
});

const withLine = { command_id, version: z.number().int().min(1), line_id };
const withSide = { ...withLine, side: z.enum(["customer", "supplier"]) };
export const ReturnCommandInput = z.discriminatedUnion("type", [
  z.strictObject({ ...withLine, type: z.literal("route"), suppliers: supplierRoute }),
  z.strictObject({ ...withLine, type: z.literal("handoff"), supplier_note: z.string().trim().min(1).max(500).optional() }),
  z.strictObject({
    ...withSide,
    type: z.literal("decide"),
    outcome: z.enum(["credit_note", "replacement", "rejected"]),
    return_qty: z.number().int().min(0).max(100_000),
    warehouse_id: warehouse.optional(),
  }),
  z.strictObject({ ...withSide, type: z.literal("receive"), receipt_ref: ReturnRef, qty: quantity }),
  z.strictObject({
    ...withSide,
    type: z.literal("inspect"),
    receipt_ref: ReturnRef,
    restock_qty: z.number().int().min(0).max(100_000),
    stock_ref: ReturnRef.optional(),
    best_before: z.iso.date().optional(),
  }),
  z.strictObject({
    ...withSide,
    type: z.literal("settle"),
    booking_ref: ReturnRef,
    document_ref: ReturnRef,
  }),
]);

export const SupplierHandoff = z.strictObject({
  handoff_id: ReturnRef,
  owner_tenant_id: tenant,
  supplier_tenant_id: tenant,
  order_id: ReturnRef,
  case_id: ReturnRef,
  line_id,
  purchase_line_ref: ReturnRef,
  qty: quantity,
  kind: CreateReturnInput.shape.kind,
  supplier_note: z.string().trim().min(1).max(500).optional(),
});

export type DeliveryInput = z.infer<typeof DeliveryInput>;
export type CreateReturnInput = z.infer<typeof CreateReturnInput>;
export type ReturnCommand = z.infer<typeof ReturnCommandInput>;
export type SupplierHandoff = z.infer<typeof SupplierHandoff>;
