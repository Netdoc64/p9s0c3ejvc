import type { ErrorHandler } from "hono";
import type { AppContext } from "../env";
import { errorToProblem } from "../errors/problem-json";

export const errorHandler: ErrorHandler<AppContext> = (err, c) => {
  const problem = errorToProblem(err, c.var.request_id, c.env);
  const headers: Record<string, string> = {
    "Content-Type": "application/problem+json",
    "X-Request-Id": c.var.request_id,
  };
  // #L-007: WWW-Authenticate auf 401 (RFC 7235).
  if (problem.status === 401) {
    headers["WWW-Authenticate"] = "Bearer realm=\"grosshandel\"";
  }
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers,
  });
};
