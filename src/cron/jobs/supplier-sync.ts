import { FloridayClient, floridayConfig } from "../../integrations/floriday";
import { reconcilePendingPurchases } from "../../integrations/purchase-orders";
import { syncSupplier } from "../../integrations/supplier-sync";
import type { CronJob } from "../registry";

export const supplierSyncJob: CronJob = {
  id: "supplier-sync",
  cron: "7,22,37,52 * * * *",
  description: "Aktualisiert aktivierte Lieferanten-Kataloge und Angebote.",
  pause_after_failures: false,
  handler: async ({ env }) => {
    if (!env.FLORIDAY_CONNECTIONS) return;
    const tenants = await env.DB.prepare(`
      SELECT tenant.id FROM tenants AS tenant
      JOIN json_each(?) AS config ON config.key = tenant.id
      WHERE tenant.status = 'active' AND tenant.deleted_at IS NULL
        AND json_extract(config.value, '$.scheduled') = 1
      ORDER BY tenant.id
    `).bind(env.FLORIDAY_CONNECTIONS).all<{ id: string }>();
    // Individual failures must not prevent other tenants from progressing.
    for (const { id } of tenants.results) {
      try {
        const config = floridayConfig(env, id);
        if (!config?.scheduled) continue;
        const client = new FloridayClient(config);
        const connection = { tenantId: id, provider: "floriday", connection: client.connection };
        try {
          await syncSupplier(env.DB, connection, client);
        } catch {
          console.error(JSON.stringify({ event: "supplier.sync_failed", provider: "floriday", tenant_id: id }));
        }
        await reconcilePendingPurchases(env.DB, connection, client);
      } catch {
        console.error(JSON.stringify({ event: "supplier.connection_failed", provider: "floriday", tenant_id: id }));
      }
    }
  },
};
