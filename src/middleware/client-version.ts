import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { client_min_versions } from "../db/schema/client-versions";
import { isVersionAtLeast } from "../services/version-cmp";

const SUPPORTED_PLATFORMS = new Set(["ios", "android", "web"]);

/**
 * Pflicht für Customer-Routes:
 *   X-Client-Version: SemVer
 *   X-Client-Platform: ios|android|web
 * Vergleicht gegen `client_min_versions[tenant, platform]`. < min → 426 Upgrade Required.
 */
export const clientVersionGuard = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const tenant_id = c.var.tenant_id;
  const version = c.req.header("X-Client-Version");
  const platform = c.req.header("X-Client-Platform")?.toLowerCase();
  if (!version || !platform) throw new CodedError("GH-INPUT-001", { reason: "X-Client-Version + X-Client-Platform required" });
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new CodedError("GH-INPUT-001", { reason: "unsupported platform" });
  if (!tenant_id) throw new CodedError("GH-AUTH-001");

  const db = getDb(c.env.DB);
  const rows = await db.select().from(client_min_versions).where(and(eq(client_min_versions.tenant_id, tenant_id), eq(client_min_versions.platform, platform))).limit(1);
  const cfg = rows[0];
  if (!cfg) {
    // Kein min_version konfiguriert → durchlassen
    await next();
    return;
  }
  if (!isVersionAtLeast(version, cfg.min_version)) {
    throw new CodedError("GH-CLIENT-001", { min_version: cfg.min_version, actual: version, platform });
  }

  // Soft-Sunset-Hinweis (30d vor Hard-Cutoff)
  if (cfg.hard_cutoff_at && new Date(cfg.hard_cutoff_at).getTime() - Date.now() < 30 * 86_400_000) {
    c.res.headers.set("X-Client-Status", "deprecated");
    c.res.headers.set("Sunset", cfg.hard_cutoff_at);
  }
  await next();
};
