import { Hono } from "hono";
import type { AppContext } from "../env";

export const healthRoutes = new Hono<AppContext>();

/**
 * /health: Liveness-Probe.
 *
 * #L-010: in production wird `commit` (GIT_COMMIT) nicht ausgeliefert,
 * damit Recon (Mapping Commit-Hash → bekannte CVEs) erschwert wird.
 */
healthRoutes.get("/health", (c) => {
  const isProd = c.env.ENVIRONMENT === "production";
  return c.json({
    status: "ok",
    version: c.env.WORKER_VERSION,
    environment: c.env.ENVIRONMENT,
    ...(isProd ? {} : { commit: c.env.GIT_COMMIT ?? "dev" }),
  });
});
