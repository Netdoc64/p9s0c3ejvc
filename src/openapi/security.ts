/**
 * OpenAPI Security-Schemes für die zwei Auth-Welten:
 *  - tenant_hmac: Tenant-API-Key + HMAC-Signatur (B2B-Backends)
 *  - customer_jwt: Bearer-JWT aus M02b (Mobile/MCP)
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "../env";

export function registerSecuritySchemes(app: OpenAPIHono<AppContext>): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "tenant_hmac", {
    type: "apiKey",
    in: "header",
    name: "X-Api-Key",
    description: "Tenant-API-Key. Muss zusätzlich von X-Signature (HMAC-SHA256) und X-Timestamp (Unix-Sekunden, ±5min Skew) begleitet werden. Signing-String: METHOD\\nPATH+QUERY\\nTIMESTAMP\\nSHA256(BODY). PATH+QUERY enthält Query-String (#A-002).",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "customer_jwt", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Customer-JWT (HS256, per-Tenant-Secret) aus /v1/auth/magic-link/verify oder /v1/auth/oauth/token.",
  });
}

export const TENANT_AUTH = [{ tenant_hmac: [] }];
export const CUSTOMER_AUTH = [{ customer_jwt: [] }];
