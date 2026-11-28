import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { verifyStaffToken } from "../auth/staff";
import { auth } from "./auth";

/**
 * Tenant-Bereich `/v1/*`: zwei Wege hinein, sonst keiner.
 *
 *  - `X-Api-Key` + HMAC-Signatur (Maschinen, Integrationen) → `auth()`
 *  - `Authorization: Bearer <Mitarbeiter-Token>` (Händler-Dashboard)
 *
 * Trägt ein Aufruf beides, gilt der API-Key-Weg — ein mitgeschicktes Token
 * öffnet nichts zusätzlich. Ein Kunden-Token scheitert an der Audience.
 *
 * Ein Mitarbeiter erscheint in Protokollen als `staff:<id>` dort, wo sonst die
 * API-Key-Id steht (`actor_id`), damit jede Änderung einer Person zuzuordnen ist.
 */
export const tenantAuth = (): MiddlewareHandler<AppContext> => {
  const hmac = auth();
  return async (c, next) => {
    if (c.req.header("X-Api-Key")) {
      // Ein Key mit Scope "read" darf nur lesen. Unbekannte Scopes gelten als "read" — nie als mehr.
      return hmac(c, async () => {
        const scope = c.var.api_key_scope ?? "full";
        if (scope !== "full" && !["GET", "HEAD"].includes(c.req.method)) throw new CodedError("GH-AUTH-004");
        await next();
      });
    }
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) throw new CodedError("GH-AUTH-001");
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new CodedError("GH-AUTH-001");
    const s = await verifyStaffToken(c.env, token);
    c.set("tenant_id", s.tenant_id);
    c.set("api_key_id", `staff:${s.staff_id}`);
    c.set("staff_id", s.staff_id);
    c.set("staff_role", s.role);
    await next();
  };
};

/** Nur Inhaber (oder ein API-Key, der für den ganzen Tenant spricht). */
export const ownerOnly = (): MiddlewareHandler<AppContext> => async (c, next) => {
  if (c.var.staff_id && c.var.staff_role !== "owner") throw new CodedError("GH-AUTH-004");
  await next();
};
