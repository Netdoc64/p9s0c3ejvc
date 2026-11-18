import { z } from "zod";

export const AddressSchema = z.object({
  line1: z.string().min(1).max(120),
  line2: z.string().max(120).optional(),
  postal_code: z.string().min(1).max(20),
  city: z.string().min(1).max(80),
  country: z.string().regex(/^[A-Z]{2}$/),
  region: z.string().max(80).optional(),
});

export type Address = z.infer<typeof AddressSchema>;

// .strict() (#V-001): unbekannte Felder → 400 statt silent-strip.
// metadata-Größenlimit (#V-002): 16k Zeichen JSON-Stringified.
export const CustomerCreateSchema = z.object({
  external_id: z.string().max(120).optional(),
  name: z.string().min(1).max(160),
  email: z.string().email().max(160).optional(),
  phone: z.string().max(40).optional(),
  country: z.string().regex(/^[A-Z]{2}$/),
  b2b_b2c: z.enum(["b2b", "b2c"]),
  vat_id: z.string().max(40).optional(),
  language: z.string().max(10).optional(),
  credit_limit_cents: z.number().int().nonnegative().max(1_000_000_000_00).optional(),
  addresses: z.object({
    billing: AddressSchema,
    shipping: AddressSchema.optional(),
  }).strict(),
  metadata: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 16384, "metadata too large").optional(),
}).strict();

export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;

// CustomerPatch erbt strict-Behavior, da CustomerCreateSchema strict ist.
// .partial() macht alle Felder optional, behält .strict()-Verhalten.
export const CustomerPatchSchema = CustomerCreateSchema.partial();
export type CustomerPatch = z.infer<typeof CustomerPatchSchema>;

export const VatStatusSchema = z.enum(["valid", "invalid", "unknown", "not_required"]);
export type VatStatus = z.infer<typeof VatStatusSchema>;
