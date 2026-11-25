import { Hono } from "hono";
import type { AppContext, Env, OutboxMessage } from "./env";
import { healthRoutes } from "./routes/health";
import { adminRoutes } from "./routes/admin";
import { staffAuthRoutes, staffRoutes } from "./routes/staff";
import { tenantAuth } from "./middleware/tenant-auth";
import { customersRoutes } from "./routes/customers";
import { suppliersRoutes } from "./routes/suppliers";
import { productsRoutes } from "./routes/products";
import { authRoutes } from "./routes/auth";
import { pricingRoutes } from "./routes/pricing";
import { stockRoutes } from "./routes/stock";
import { batchesRoutes } from "./routes/batches";
import { ordersRoutes } from "./routes/orders";
import { customerReturnsRoutes, returnsRoutes, supplierReturnsRoutes } from "./routes/returns";
import { invoicesRoutes, publicInvoicesRoutes } from "./routes/invoices";
import { webhooksRoutes } from "./routes/webhooks";
import { mcpRoutes } from "./routes/mcp";
import { devicesRoutes } from "./routes/devices";
import { dsgvoRoutes } from "./routes/dsgvo";
import { customerAuth } from "./middleware/customer-auth";
import { clientVersionGuard } from "./middleware/client-version";
import { customerApiRoutes } from "./routes/customer-api";
import { productImagesRoutes } from "./routes/product-images";
import { errorHandler, idempotency, logger, requestId } from "./middleware";
import { securityHeaders } from "./middleware/security-headers";
import { cors } from "./middleware/cors";
import { queueHandler } from "./workers/queue-handler";
import { scheduled } from "./cron";
import { docsRoutes } from "./openapi";

const app = new Hono<AppContext>();

app.use("*", requestId());
app.use("*", securityHeaders());
app.use("*", cors());
app.use("*", logger());
app.onError(errorHandler);

app.notFound((c) => {
  const body = {
    type: "https://errors.grosshandel.app/GH-INFRA-NOT-FOUND",
    title: "Not Found",
    status: 404,
    detail: "Route not found",
    instance: c.var.request_id,
  };
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Request-Id": c.var.request_id,
    },
  });
});

// /health bleibt unauthentifiziert
app.route("/", healthRoutes);

// Betriebs-Endpunkte für den Business Manager (eigener Schlüssel, kein Tenant)
app.route("/admin", adminRoutes);

// OpenAPI 3.1 Spec + Schema-Exports (öffentlich für SDK-Generierung)
app.route("/", docsRoutes);

// Mitarbeiter-Anmeldung (Händler-Dashboard), öffentlich wie die Kunden-Anmeldung
app.route("/v1/auth/staff", staffAuthRoutes);

// Customer-Auth-Endpoints (tenant-resolved via X-Tenant-Slug, kein API-Key)
app.route("/v1/auth", authRoutes);

// Public Invoice-Download via Signed-URL (#P-005, kein API-Key nötig)
app.route("/v1/public/invoices", publicInvoicesRoutes);
// Produktbilder öffentlich und cachebar (zufällige ID, Inhalts-Hash in R2)
app.route("/v1/public/product-images", productImagesRoutes);

// MCP-Endpoint (eigene Auth via Bearer JWT in der Route selbst)
app.route("/mcp", mcpRoutes);

// Customer-Self-Endpoints (JWT Bearer, kein API-Key).
//
// MUSS VOR dem Tenant-Bereich stehen. `v1.use("*", auth())` unter "/v1" greift
// auch für /v1/customer/* und verlangt dort API-Key + HMAC; Hono führt alle
// passenden Handler in Registrierungsreihenfolge aus. Bis 2026-11-17 stand
// dieser Block dahinter, und KEIN Kunden-Token kam je durch (401) — auch die
// Geräteregistrierung nicht. tests/routes/customer-api.spec.ts hält das fest.
const customer = new Hono<AppContext>();
customer.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});
customer.use("*", customerAuth());
// M24: Pflicht-Header X-Client-Version + X-Client-Platform für Kunden-Routen.
// Existierte seit dem Autopilot-Build, war aber nirgends eingehängt.
customer.use("*", clientVersionGuard());
// Idempotenz je KUNDE (siehe middleware/idempotency.ts): eine Wiederholung nach
// Netzverlust liefert dieselbe Antwort statt einer zweiten Bestellung.
customer.use("*", idempotency());
customer.route("/devices", devicesRoutes);
customer.route("/", customerApiRoutes);
customer.route("/orders", customerReturnsRoutes);
app.route("/v1/customer", customer);

// Authentifizierter Bereich — alle Routes ab v1
const v1 = new Hono<AppContext>();
// API-Key + HMAC ODER Mitarbeiter-Token (siehe middleware/tenant-auth.ts)
v1.use("*", tenantAuth());
v1.use("*", idempotency());
v1.route("/customers", customersRoutes);
v1.route("/products", productsRoutes);
v1.route("/suppliers", suppliersRoutes);
v1.route("/pricing", pricingRoutes);
v1.route("/stock", stockRoutes);
v1.route("/stock/batches", batchesRoutes);
v1.route("/orders", ordersRoutes);
v1.route("/orders", returnsRoutes);
v1.route("/suppliers", supplierReturnsRoutes);
v1.route("/invoices", invoicesRoutes);
v1.route("/webhooks", webhooksRoutes);
v1.route("/dsgvo", dsgvoRoutes);
v1.route("/staff", staffRoutes);
app.route("/v1", v1);


// Re-Export DOs für wrangler-Bindings
export { StockDO } from "./do/stock";
export { ReturnsDO } from "./do/returns";
export { ReturnsSupplierInbox } from "./workers/returns-supplier-inbox";
export { CronLockDO } from "./cron/lock-do";
export { InvoiceNumberDO } from "./do/invoice-number";
export { RateLimitDO } from "./do/rate-limit";

// HANDLER GEHÖREN AN DEN STANDARDEXPORT. Cloudflare ruft `fetch`, `scheduled`
// und `queue` nur am `export default` auf; benannte Exporte gleichen Namens
// werden still ignoriert. Bis 2026-11-17 stand hier `export default app` plus
// `export { scheduled }` / `export const queue` — damit liefen weder Cron-Jobs
// (Outbox-Sweep, Backups, Cleanup) noch der Queue-Consumer, und kein Test mit
// `SELF.fetch` konnte das sehen. Aufgefallen beim ersten echten Deploy:
// „Queue handler is missing“. tests/worker-entry.spec.ts hält das fest.
export { scheduled };
export const queue = queueHandler;

export default {
  fetch: app.fetch,
  scheduled,
  queue: queueHandler,
} satisfies ExportedHandler<Env, OutboxMessage>;
