import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { newRequestId } from "../lib/ids";

// #L-005: Request-ID muss alphanumeric (+ - _) sein, sonst Log-Injection-Risiko.
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const requestId = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const incoming = c.req.header("X-Request-Id");
  const id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : newRequestId();
  c.set("request_id", id);
  await next();
  c.res.headers.set("X-Request-Id", id);
};
