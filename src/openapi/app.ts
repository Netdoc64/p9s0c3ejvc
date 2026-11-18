/**
 * OpenAPIHono-typisiert für unseren AppContext.
 * Eine Factory damit Route-Files den gleichen typed-app erzeugen.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "../env";
import { errorToProblem } from "../errors/problem-json";

export type ApiApp = OpenAPIHono<AppContext>;

export function makeApiApp(): ApiApp {
  const app = new OpenAPIHono<AppContext>({
    defaultHook: (result, c) => {
      // Zod-Parse-Fehler werden zu RFC-7807 → GH-INPUT-001
      if (!result.success) {
        const problem = {
          type: "https://errors.grosshandel.app/GH-INPUT-001",
          title: "Ungültige Eingabe.",
          status: 400,
          detail: "Zod validation failure",
          instance: c.var.request_id ?? "unknown",
          code: "GH-INPUT-001",
          issues: result.error.flatten(),
        };
        return new Response(JSON.stringify(problem), {
          status: 400,
          headers: { "Content-Type": "application/problem+json", "X-Request-Id": c.var.request_id ?? "" },
        });
      }
      return undefined;
    },
  });
  return app;
}

export { errorToProblem };
