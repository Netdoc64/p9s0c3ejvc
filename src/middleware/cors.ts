import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";

/**
 * CORS-Middleware (#L-004).
 *
 * Decision: für v1 erlauben wir alle Origins auf:
 *  - /v1/auth/* (Magic-Link/OAuth aus Browser)
 *  - /v1/customer/* NUR für die Origins in CUSTOMER_APP_ORIGINS (Komma-Liste,
 *    Web-Build der Kunden-App). Native Apps brauchen kein CORS; ohne Variable
 *    bleibt die Kunden-API für Browser fremder Origins gesperrt.
 *  - /mcp (MCP-Clients sind generell von verschiedenen Origins)
 *  - /openapi.json + /schemas/* (SDK-Generierung)
 *  - /health (Probe von Monitoring)
 *
 * Tenant-API (signiert via HMAC) ist von Browsern eh nicht direkt aufrufbar
 * (CORS-preflight würde keine Bearer-Token-/Signing-Header bringen).
 *
 * Allowed Headers: typische API-Headers + unsere Custom-Header.
 */
const PUBLIC_PATHS = [
  /^\/health$/,
  /^\/openapi\.json$/,
  /^\/schemas\//,
  /^\/v1\/auth\//,
  /^\/mcp$/,
];

const ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Api-Key",
  "X-Signature",
  "X-Timestamp",
  "X-Idempotency-Key",
  "X-Tenant-Slug",
  "X-Client-Version",
  "X-Client-Platform",
  "X-Request-Id",
].join(", ");

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(path));
}

const CUSTOMER_PATH = /^\/v1\/customer\//;

function inList(origin: string, list: string | undefined): boolean {
  return Boolean(list) && (list as string).split(",").map((o) => o.trim()).filter(Boolean).includes(origin);
}

function customerOriginAllowed(path: string, origin: string, list: string | undefined): boolean {
  return CUSTOMER_PATH.test(path) && inList(origin, list);
}

/** Händler-Dashboard: Tenant-Bereich /v1/* (ohne /v1/customer) nur für STAFF_APP_ORIGINS. */
const TENANT_PATH = /^\/v1\//;
function staffOriginAllowed(path: string, origin: string, list: string | undefined): boolean {
  return TENANT_PATH.test(path) && !CUSTOMER_PATH.test(path) && inList(origin, list);
}

export const cors = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const origin = c.req.header("Origin");
  const isPreflight = c.req.method === "OPTIONS";
  const path = new URL(c.req.url).pathname;

  if (origin && (isPublic(path) || customerOriginAllowed(path, origin, c.env.CUSTOMER_APP_ORIGINS) || staffOriginAllowed(path, origin, c.env.STAFF_APP_ORIGINS))) {
    if (isPreflight) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": ALLOWED_HEADERS,
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Vary", "Origin");
    return;
  }
  // Tenant-API + andere → kein CORS (default same-origin policy = blocked from browsers).
  return next();
};
