import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";

/**
 * Security-Headers (#L-003) — defaults für alle Responses.
 * - HSTS: 1 Jahr, includeSubDomains.
 * - X-Content-Type-Options: nosniff.
 * - Referrer-Policy: no-referrer.
 * - Permissions-Policy: hart restriktiv (keine Geolocation/Camera/Mic).
 * - X-Frame-Options: DENY (API serviert kein HTML, aber doppelt hält).
 */
export const securityHeaders = (): MiddlewareHandler<AppContext> => async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
};
