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
  app.openAPIRegistry.registerComponent("securitySchemes", "staff_jwt", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Mitarbeiter-Token aus /v1/auth/staff/code/verify (Händler-Dashboard). Gilt für /v1/*, nie für /v1/customer/*.",
  });
}

export const TENANT_AUTH: Array<Record<string, string[]>> = [{ tenant_hmac: [] }, { staff_jwt: [] }];
export const CUSTOMER_AUTH = [{ customer_jwt: [] }];
