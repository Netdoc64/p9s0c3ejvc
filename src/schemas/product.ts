import { z } from "zod";

export const PackagingUnitSchema = z.object({
  name: z.string().min(1).max(40),
  contains: z.number().int().positive(),
  unit_of_inner: z.string().min(1).max(20),
});
export type PackagingUnit = z.infer<typeof PackagingUnitSchema>;

export const TaxClassSchema = z.enum(["standard", "reduced", "zero"]);

export const ProductCreateSchema = z.object({
  sku_code: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "sku_code must be alphanumeric"),
  parent_sku_id: z.string().startsWith("sku_").optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  tax_class: TaxClassSchema.default("standard"),
  is_perishable: z.boolean().default(false),
  default_shelf_life_days: z.number().int().positive().max(36500).optional(),
  min_order_qty: z.number().int().positive().max(1_000_000).default(1),
  packaging_units: z.array(PackagingUnitSchema).max(20).default([]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({})
    .refine((v) => JSON.stringify(v).length <= 16384, "attributes too large"),
}).strict();

export type ProductCreate = z.infer<typeof ProductCreateSchema>;
export const ProductPatchSchema = ProductCreateSchema.partial();
export type ProductPatch = z.infer<typeof ProductPatchSchema>;
