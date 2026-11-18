import { z } from "zod";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /**
   * Explizit erforderlicher Scope. Audit-Fix #M-001:
   * vorher war "read"/"write" mit invertierter Check-Logik gefährlich verwirrend.
   */
  requiredScope: "customer_self.read" | "customer_self.write";
}

export const SEARCH_PRODUCTS: McpTool = {
  name: "search_products",
  description: "Sucht im Katalog nach Begriff. Read-only.",
  inputSchema: z.object({ q: z.string().min(1).max(120), limit: z.number().int().min(1).max(50).optional() }),
  requiredScope: "customer_self.read",
};

export const GET_PRICE_QUOTE: McpTool = {
  name: "get_price_quote",
  description: "Liefert Pricing-Quote für (sku, qty) für den authenticated Customer.",
  inputSchema: z.object({ sku_id: z.string().startsWith("sku_"), qty: z.number().int().positive() }),
  requiredScope: "customer_self.read",
};

export const LIST_CUSTOMERS: McpTool = {
  name: "list_customers",
  description: "Listet Kunden des Tenants (read-only). Verwende mit Cursor.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().optional() }),
  requiredScope: "customer_self.read",
};

export const CREATE_ORDER_DRAFT: McpTool = {
  name: "create_order_draft",
  description: "Erstellt eine Order im Status 'awaiting_confirmation'. Verändert NICHT den Bestand permanent — das tut erst confirm_order. Output enthält den Order-Doc mit allen aufgelösten Preisen/Steuern.",
  inputSchema: z.object({
    customer_id: z.string().startsWith("cust_"),
    lines: z.array(z.object({ sku_id: z.string().startsWith("sku_"), qty: z.number().int().positive() })).min(1),
  }),
  requiredScope: "customer_self.write",
};

export const CONFIRM_ORDER: McpTool = {
  name: "confirm_order",
  description: "Bestätigt einen Order-Draft. Commit Stock + emit order.confirmed-Event. NICHT umkehrbar ohne cancel_order.",
  inputSchema: z.object({ order_id: z.string().startsWith("ord_") }),
  requiredScope: "customer_self.write",
};

export const CANCEL_ORDER: McpTool = {
  name: "cancel_order",
  description: "Storniert einen Auftrag (release Stock + emit order.cancelled-Event).",
  inputSchema: z.object({ order_id: z.string().startsWith("ord_"), reason: z.string().max(200).optional() }),
  requiredScope: "customer_self.write",
};

export const GET_ORDER: McpTool = {
  name: "get_order",
  description: "Liest einen Auftrag (read-only).",
  inputSchema: z.object({ order_id: z.string().startsWith("ord_") }),
  requiredScope: "customer_self.read",
};

export const LIST_ORDERS: McpTool = {
  name: "list_orders",
  description: "Listet Aufträge des Tenants (read-only).",
  inputSchema: z.object({
    customer_id: z.string().optional(),
    // Enum statt freier String (#T-011)
    state: z.enum([
      "draft",
      "resolving",
      "awaiting_confirmation",
      "confirmed",
      "shipped",
      "invoiced",
      "paid",
      "cancelled",
      "on_hold",
    ]).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  requiredScope: "customer_self.read",
};

export const TOOLS: McpTool[] = [
  SEARCH_PRODUCTS,
  GET_PRICE_QUOTE,
  LIST_CUSTOMERS,
  CREATE_ORDER_DRAFT,
  CONFIRM_ORDER,
  CANCEL_ORDER,
  GET_ORDER,
  LIST_ORDERS,
];

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((t) => t.name === name);
}
