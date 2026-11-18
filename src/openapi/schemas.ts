/**
 * Wiederverwendbare Response-Schemas (Problem-JSON, Pagination).
 * Plus thin re-exports aller Domain-Schemas für die OpenAPI-Routes.
 */
import { z } from "@hono/zod-openapi";

export const ProblemSchema = z
  .object({
    type: z.string().url().openapi({ example: "https://errors.grosshandel.app/GH-AUTH-001" }),
    title: z.string().openapi({ example: "Authentifizierung fehlgeschlagen." }),
    status: z.number().int().openapi({ example: 401 }),
    detail: z.string(),
    instance: z.string().openapi({ example: "01HZK..." }),
    code: z.string().openapi({ example: "GH-AUTH-001" }),
  })
  .passthrough()
  .openapi("Problem");

export const EmptySchema = z.object({}).openapi("Empty");

export const PaginatedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const StateHistoryEntrySchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  by_step_id: z.string().optional(),
  ts: z.string(),
});

export const IdempotencyHeaderSchema = z.object({
  "X-Idempotency-Key": z.string().min(1).max(120).optional(),
});
