import type { Env } from "../env";
import { signJwt } from "./jwt";
import { issueRefresh } from "./refresh";
import { newId } from "../lib/ids";
import { CodedError } from "../errors/catalog";
import { getTenantById } from "../lib/tenant-cache";
import { getDb } from "../db/client";

const ACCESS_TTL_SEC = 900;

export interface IssuedPair {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/**
 * Issue Access+Refresh-Token-Paar.
 *
 * `opts.skipRefresh` (#A-008): wenn ein bestehender Refresh-Token weiter genutzt
 * werden soll (z.B. nach `rotateRefresh`), wird kein neuer angelegt — verhindert
 * Orphan-Tokens.
 */
export async function issueTokenPair(env: Env, tenant_id: string, customer_id: string, scope: string[], client_id?: string, opts?: { skipRefresh?: boolean }): Promise<IssuedPair> {
  const tenant = await getTenantById(env, tenant_id);
  if (!tenant) throw new CodedError("GH-TENANT-001");
  const db = getDb(env.DB);

  // Scope-Expansion (#M-001): legacy "customer_self" wird zu read+write erweitert,
  // damit neue MCP-Tool-Checks gegen explizite Scopes greifen.
  const expandedScope = expandScopes(scope);

  const now = Math.floor(Date.now() / 1000);
  const access = await signJwt({
    iss: `tenants:${tenant_id}`,
    sub: customer_id,
    aud: "grosshandel.api",
    exp: now + ACCESS_TTL_SEC,
    iat: now,
    scope: expandedScope,
    tenant_id,
    jti: newId("event"),
  }, tenant.customer_jwt_secret);

  if (opts?.skipRefresh) {
    return {
      access_token: access,
      refresh_token: "",
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      scope: expandedScope.join(" "),
    };
  }

  const refresh = await issueRefresh(db, { tenant_id, customer_id, scope: expandedScope, client_id });

  return {
    access_token: access,
    refresh_token: refresh.plain,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope: expandedScope.join(" "),
  };
}

function expandScopes(scope: string[]): string[] {
  const out = new Set(scope);
  if (out.has("customer_self")) {
    out.add("customer_self.read");
    out.add("customer_self.write");
  }
  return [...out];
}
