import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { tenant_pricing_feeds } from "../../db/schema/feeds";
import { runFeed } from "../../services/pricing-feeds";
import type { CronJob } from "../registry";

export const pricingFeedPullJob: CronJob = {
  id: "pricing-feed-pull",
  cron: "0 5 * * *",
  description: "Pulled aktive Pricing-Feeds (Aalsmeer/RBC/CSV) und erzeugt neue price_list-Version mit Drift-Detection.",
  pause_after_failures: 5,
  handler: async ({ env }) => {
    const db = getDb(env.DB);
    const feeds = await db.select().from(tenant_pricing_feeds).where(eq(tenant_pricing_feeds.enabled, 1));
    for (const f of feeds) {
      try { await runFeed(env, f.id); } catch { /* per-feed already logged */ }
    }
  },
};
