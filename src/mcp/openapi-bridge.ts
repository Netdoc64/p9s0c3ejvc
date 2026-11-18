/**
 * MCP-Tool ↔ OpenAPI-Operation Mapping.
 * Jeder MCP-Tool referenziert eine Operation in der OpenAPI-Spec — damit
 * Clients dokumentierte API-Pfade kennen und Tool-Schemas aus dem OpenAPI-
 * Doc gegenprüfen können.
 */

export interface ToolApiBinding {
  tool: string;
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
}

export const TOOL_BINDINGS: ReadonlyArray<ToolApiBinding> = [
  { tool: "search_products",     operationId: "searchProducts",  method: "GET",  path: "/v1/products/search" },
  { tool: "get_price_quote",     operationId: "pricingQuote",    method: "POST", path: "/v1/pricing/quote" },
  { tool: "list_customers",      operationId: "listCustomers",   method: "GET",  path: "/v1/customers" },
  { tool: "create_order_draft",  operationId: "createOrder",     method: "POST", path: "/v1/orders" },
  { tool: "confirm_order",       operationId: "confirmOrder",    method: "POST", path: "/v1/orders/{id}/confirm" },
  { tool: "cancel_order",        operationId: "cancelOrder",     method: "POST", path: "/v1/orders/{id}/cancel" },
  { tool: "get_order",           operationId: "getOrder",        method: "GET",  path: "/v1/orders/{id}" },
  { tool: "list_orders",         operationId: "listOrders",      method: "GET",  path: "/v1/orders" },
];

export function findBinding(toolName: string): ToolApiBinding | undefined {
  return TOOL_BINDINGS.find((b) => b.tool === toolName);
}
