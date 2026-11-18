import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { redactPii } from "../observability/pii";
import { counter, histogram } from "../observability/metrics";
import { ERROR_CATALOG, type ErrorCode } from "../errors/catalog";

export const logger = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const start = performance.now();
  let errorCode: string | undefined;
  let inferredStatus: number | undefined;
  try {
    await next();
  } catch (err) {
    if (err instanceof Error && "code" in err && typeof err.code === "string") {
      errorCode = err.code;
      // #L-011: Status aus Error-Catalog ableiten, da c.res.status zum Logger-Zeitpunkt
      // noch das Default ist (errorHandler läuft erst danach).
      const entry = ERROR_CATALOG[err.code as ErrorCode];
      if (entry) inferredStatus = entry.http_status === 0 ? 500 : entry.http_status;
      else inferredStatus = 500;
    } else {
      inferredStatus = 500;
    }
    throw err;
  } finally {
    const duration_ms = Math.round(performance.now() - start);
    const tenant_id = c.var.tenant_id;
    const customer_id = c.var.customer_id;
    const status = inferredStatus ?? c.res?.status;
    const idempotency_hit = c.res?.headers.get("X-Idempotency-Hit") === "true";
    const route = `${c.req.method} ${c.req.routePath ?? c.req.path}`;
    const log = await redactPii({
      level: status && status >= 500 ? "error" : status && status >= 400 ? "warn" : "info",
      ts: new Date().toISOString(),
      request_id: c.var.request_id,
      tenant_id,
      customer_id,
      route,
      status,
      duration_ms,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(idempotency_hit ? { idempotency_hit: true } : {}),
    });

    // Health-Sampling (#L-006): 5xx werden voll geloggt, sonst 1% Sample.
    const isHealth = c.req.path === "/health";
    const shouldEmit = !isHealth || (status !== undefined && status >= 500) || Math.random() < 0.01;
    if (shouldEmit) {
      console.log(JSON.stringify(log));
    }

    // Metrics — niedrige Cardinality. Health: nur 5xx + 1% Sample.
    if (status !== undefined && shouldEmit) {
      counter("http.requests", 1, { route, status, error_code: errorCode ?? "" });
      histogram("http.duration_ms", duration_ms, { route, bucket: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx" });
    }
  }
};
