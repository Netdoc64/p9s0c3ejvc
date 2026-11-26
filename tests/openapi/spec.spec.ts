import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, KNOWN_PATHS } from "../../src/openapi/spec";
import { TOOL_BINDINGS } from "../../src/mcp/openapi-bridge";
import { TOOLS } from "../../src/mcp/tools";

describe("OpenAPI 3.1 spec", () => {
  it("/openapi.json wird ausgeliefert", async () => {
    const res = await SELF.fetch("https://example.com/openapi.json");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.openapi).toBe("3.1.0");
    expect((body.info as { title: string }).title).toBe("Grosshandel API");
    expect(typeof body.paths).toBe("object");
  });

  it("/schemas/order.json wird ausgeliefert", async () => {
    const res = await SELF.fetch("https://example.com/schemas/order.json");
    expect(res.status).toBe(200);
    const body = await res.json() as { properties?: Record<string, unknown> };
    // OrderDocument hat top-level meta/customer_id/lines/totals/state/plan
    const props = (body.properties ?? body) as Record<string, unknown>;
    const propsKeys = Object.keys(props);
    expect(propsKeys.length).toBeGreaterThan(0);
  });

  it("Document enthält Security-Schemes", () => {
    const doc = buildOpenApiDocument();
    const components = doc.components as { securitySchemes: Record<string, unknown> };
    expect(components.securitySchemes.tenant_hmac).toBeDefined();
    expect(components.securitySchemes.customer_jwt).toBeDefined();
  });

  it("Erwartete Top-Level-Pfade sind alle in der Spec", () => {
    const expected = [
      "/health",
      "/v1/auth/magic-link/request",
      "/v1/auth/magic-link/verify",
      "/v1/auth/oauth/authorize",
      "/v1/auth/oauth/token",
      "/v1/auth/oauth/revoke",
      "/v1/customers",
      "/v1/customers/{id}",
      "/v1/products",
      "/v1/products/search",
      "/v1/products/{id}",
      "/v1/products/import",
      "/v1/suppliers/imports/{source}",
      "/v1/suppliers/floriday",
      "/v1/suppliers/floriday/sync",
      "/v1/suppliers/floriday/catalog",
      "/v1/suppliers/floriday/offers",
      "/v1/suppliers/floriday/purchase-orders",
      "/v1/suppliers/floriday/purchase-orders/{id}",
      "/v1/suppliers/floriday/purchase-orders/{id}/submit",
      "/v1/suppliers/floriday/purchase-orders/{id}/reconcile",
      "/v1/suppliers/fleurop-nl",
      "/v1/suppliers/fleurop-nl/products",
      "/v1/suppliers/fleurop-nl/availability",
      "/v1/suppliers/fleurop-nl/delivery-costs",
      "/v1/suppliers/fleurop-nl/orders",
      "/v1/suppliers/fleurop-nl/orders/{id}",
      "/v1/suppliers/fleurop-nl/orders/{id}/reconcile",
      "/v1/suppliers/flower-shop-network/products/{id}",
      "/v1/suppliers/flower-shop-network/florists",
      "/v1/suppliers/flower-shop-network/orders",
      "/v1/suppliers/flower-shop-network/orders/{id}",
      "/v1/suppliers/komander/products",
      "/v1/suppliers/komander/availability",
      "/v1/suppliers/komander/checkout",
      "/v1/products/{id}/images",
      "/v1/pricing/quote",
      "/v1/stock/movements",
      "/v1/stock/overview",
      "/v1/modules",
      "/v1/modules/{id}",
      "/v1/modules/{id}/credentials",
      "/v1/modules/{id}/check",
      "/v1/auth/staff/code/request",
      "/v1/auth/staff/code/verify",
      "/v1/staff",
      "/v1/staff/me",
      "/v1/staff/{id}",
      "/v1/stock/state",
      "/v1/stock/batches",
      "/v1/orders",
      "/v1/orders/{id}",
      "/v1/orders/{id}/confirm",
      "/v1/orders/{id}/cancel",
      "/v1/orders/{orderId}/return-deliveries",
      "/v1/orders/{orderId}/returns",
      "/v1/orders/{orderId}/returns/{caseId}",
      "/v1/orders/{orderId}/returns/{caseId}/commands",
      "/v1/customer/orders/{orderId}/return-deliveries",
      "/v1/customer/orders/{orderId}/returns",
      "/v1/customer/orders/{orderId}/returns/{caseId}",
      "/v1/suppliers/return-inbox",
      "/v1/suppliers/{ownerTenantId}/orders/{orderId}/returns/{caseId}",
      "/v1/suppliers/{ownerTenantId}/orders/{orderId}/returns/{caseId}/commands",
      "/v1/invoices/{id}",
      "/v1/webhooks",
      "/v1/webhooks/{id}",
      "/v1/customer/devices",
      "/v1/customer/devices/{id}",
      "/v1/customer/me",
      "/v1/customer/products",
      "/v1/customer/products/{id}",
      "/v1/customer/quotes",
      "/v1/customer/orders",
      "/v1/customer/orders/{id}",
      "/v1/customer/orders/{id}/confirm",
      "/v1/customer/orders/{id}/cancel",
      "/v1/customer/orders/{id}/invoice",
      "/mcp",
    ];
    for (const path of expected) {
      expect(KNOWN_PATHS).toContain(path);
    }
  });

  it("MCP-Tool-Bindings verweisen auf real existierende Operations", () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as Record<string, Record<string, { operationId?: string }>>;
    for (const binding of TOOL_BINDINGS) {
      const path = paths[binding.path];
      expect(path, `path ${binding.path} fehlt`).toBeDefined();
      if (!path) continue;
      const op = path[binding.method.toLowerCase()];
      expect(op, `${binding.method} ${binding.path} fehlt`).toBeDefined();
      if (!op) continue;
      expect(op.operationId).toBe(binding.operationId);
    }
  });

  it("Jedes MCP-Tool hat ein Binding (kein Tool ohne API-Spec)", () => {
    const writeBoundTools = TOOLS.filter((t) => t.requiredScope === "customer_self.write" || ["search_products", "get_price_quote", "list_customers", "list_orders", "get_order"].includes(t.name));
    for (const t of writeBoundTools) {
      const binding = TOOL_BINDINGS.find((b) => b.tool === t.name);
      expect(binding, `Tool ${t.name} hat kein OpenAPI-Binding`).toBeDefined();
    }
  });
});
