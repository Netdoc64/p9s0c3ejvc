import type { Context } from "hono";
import { CodedError, ERROR_CATALOG, type ErrorCode, isCodedError, lookup } from "./catalog";
import type { AppContext } from "../env";

const PROBLEM_TYPE_BASE = "https://errors.grosshandel.app/";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ErrorCode;
  [key: string]: unknown;
}

export function toProblem(
  code: ErrorCode,
  request_id: string,
  extra?: Record<string, unknown>,
): ProblemDetails {
  const entry = lookup(code);
  return {
    type: PROBLEM_TYPE_BASE + code,
    title: entry.user_message,
    status: entry.http_status === 0 ? 500 : entry.http_status,
    detail: entry.user_message,
    instance: request_id,
    code,
    ...extra,
  };
}

export function problemResponse(c: Context<AppContext>, code: ErrorCode, extra?: Record<string, unknown>): Response {
  const request_id = c.var.request_id;
  const problem = toProblem(code, request_id, extra);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export function errorToProblem(err: unknown, request_id: string, env?: { ENVIRONMENT?: string }): ProblemDetails {
  if (isCodedError(err)) {
    return toProblem(err.code, request_id, err.detail);
  }
  // #L-002: cause nur in dev/staging exposen, in production weglassen (Info-Leak).
  const isProd = env?.ENVIRONMENT === "production";
  if (isProd) {
    return toProblem("GH-INFRA-002", request_id);
  }
  return toProblem("GH-INFRA-002", request_id, {
    cause: err instanceof Error ? err.message : String(err),
  });
}

export { CodedError, ERROR_CATALOG, lookup };
