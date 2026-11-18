/**
 * Zod -> JSON Schema, eine Stelle für alle Ausgaben (OpenAPI, /schemas/*, MCP).
 *
 * Seit Zod 4 eingebaut (`z.toJSONSchema`); `zod-to-json-schema` kennt Zod 4
 * nicht. Ziel bleibt OpenAPI 3.0 wie zuvor (`nullable` statt Typ-Listen), und
 * es wird die EINGABE-Seite beschrieben: ein Feld mit Default ist für den
 * Aufrufer optional. Nicht darstellbare Typen (Transforms, Dates) werden zu
 * `{}` statt zu werfen — ein Schema-Endpunkt darf nicht an einem Feld sterben.
 */
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
    reused: "inline",
  }) as JsonSchema;
}
