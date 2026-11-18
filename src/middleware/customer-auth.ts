import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { verifyJwt, type JwtSecretSet } from "../auth/jwt";
import { getTenantById } from "../lib/tenant-cache";

/**
 * Customer-Auth-Middleware: liest Bearer-JWT, verifiziert via per-Tenant-Secret,
 * setzt c.var.customer_id + c.var.tenant_id + c.var.scopes.
 *
 * Tenant-Secret kommt aus 60s-KV-Cache (#A-013) — nur Cache-Miss → D1.
 * Doppel-Reader (#A-005): wenn previous_secret aktiv ist, wird er als Fallback
 * zur Verify übergeben.
 */
export const customerAuth = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) throw new CodedError("GH-AUTH-001");
  const token = auth.slice("Bearer ".length).trim();
  if (!token) throw new CodedError("GH-AUTH-001");

  // Tenant-ID aus JWT-Claims OHNE Secret-Verify (best-effort) parsen, um Secret zu laden
  const parts = token.split(".");
  if (parts.length !== 3) throw new CodedError("GH-AUTH-002");
  let claimedTenant: string;
  try {
    const p = parts[1] as string;
    const padded = p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { tenant_id?: string };
    if (!json.tenant_id) throw new Error("no tenant_id");
    claimedTenant = json.tenant_id;
  } catch {
    throw new CodedError("GH-AUTH-002");
  }

  const tenant = await getTenantById(c.env, claimedTenant);
  // Cross-Tenant-Token oder unbekannter Tenant → 404 (no leak)
  if (!tenant || tenant.status !== "active") throw new CodedError("GH-TENANT-001");

  const secretSet: JwtSecretSet = {
    current: tenant.customer_jwt_secret,
    ...(tenant.customer_jwt_secret_previous && tenant.customer_jwt_secret_previous_until && tenant.customer_jwt_secret_previous_until > new Date().toISOString()
      ? { previous: tenant.customer_jwt_secret_previous }
      : {}),
  };
  const result = await verifyJwt(token, secretSet, tenant.id);
  if (!result.ok) {
    if (result.reason === "expired") throw new CodedError("GH-AUTH-005");
    throw new CodedError("GH-AUTH-002");
  }

  c.set("tenant_id", tenant.id);
  c.set("customer_id", result.payload.sub);
  c.set("scopes", result.payload.scope);
  await next();
};
