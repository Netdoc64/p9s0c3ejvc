import { z } from "zod";
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";

const tenantConfig = z.object({ storeKey: z.string().min(1), checkout: z.boolean().default(false) });

export function komanderConfig(env: Env, tenantId: string) {
  try {
    if (!env.KOMANDER_CONNECTIONS) return undefined;
    const config = JSON.parse(env.KOMANDER_CONNECTIONS) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return Object.hasOwn(config, tenantId) ? tenantConfig.parse((config as Record<string, unknown>)[tenantId]) : undefined;
  } catch {
    throw new CodedError("GH-SUPPLIER-001", { reason: "invalid_connection_configuration" });
  }
}

const text = z.string().trim().min(1).max(150);
const postalCode = z.string().regex(/^\d{5}$/);
const store = "https://blumen-verschicken.online";
const mcp = "https://mcp.blumen-verschicken.online/mcp";
const protocol = "2025-03-26";

export const komanderSearch = z.object({
  occasion: text.optional(), color: text.optional(), flower_type: text.optional(), style: text.optional(),
  minPrice: z.coerce.number().nonnegative().optional(), maxPrice: z.coerce.number().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(), offset: z.coerce.number().int().nonnegative().optional(),
}).refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice,
  { path: ["maxPrice"], message: "maxPrice must be at least minPrice" });

export const komanderAvailability = z.object({ date: z.iso.date(), postalCode: postalCode.optional() });
export const komanderCheckout = z.object({
  variant_id: z.string().regex(/^var_[A-Za-z0-9]+$/),
  quantity: z.number().int().min(1).max(50).default(1),
  delivery_date: z.iso.date(),
  first_name: text, last_name: text, address_1: text, postal_code: postalCode,
  city: text.optional(), phone: text.optional(), email: z.email().max(254),
  greeting_card: z.string().max(500).optional(), wunsch_text: z.string().max(500).optional(),
  payment_provider: z.enum(["stripe", "paypal", "sepa"]).default("stripe"),
}).strict();

const checkoutResult = z.object({ cart_id: z.string().min(1), checkout_url: z.url() });
const envelope = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });

async function rpcResult(response: Response, id: number): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  let message: unknown;
  if (contentType.includes("text/event-stream")) {
    const events = (await response.text()).split(/\r?\n\r?\n/);
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      const value = envelope.safeParse(JSON.parse(data));
      if (value.success && value.data.id === id) {
        message = value.data;
        break;
      }
    }
  } else {
    message = await response.json();
  }
  const parsed = envelope.parse(message);
  if (parsed.id !== id || parsed.error || parsed.result === undefined) throw new Error("Komander RPC failed");
  return parsed.result;
}

export class KomanderClient {
  constructor(private readonly key: string, private readonly transport: typeof fetch = fetch) {}

  async read(path: "products/search" | "availability", parameters: Record<string, string | number>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) query.set(key, String(value));
    const response = await this.transport(`${store}/store/${path}?${query}`, {
      headers: { "X-Publishable-Api-Key": this.key, Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Komander Store API failed");
    return path === "availability"
      ? z.looseObject({ available: z.boolean() }).parse(await response.json())
      : z.looseObject({ products: z.array(z.looseObject({ id: z.string() })) }).parse(await response.json());
  }

  async checkout(input: z.infer<typeof komanderCheckout>) {
    const headers = new Headers({ Accept: "application/json, text/event-stream", "Content-Type": "application/json" });
    const request = async (method: string, payload?: Record<string, unknown>) => {
      const response = await this.transport(mcp, {
        method, headers, redirect: "manual", signal: AbortSignal.timeout(12_000),
        ...(payload ? { body: JSON.stringify({ jsonrpc: "2.0", ...payload }) } : {}),
      });
      if (!response.ok) throw new Error("Komander checkout service failed");
      return response;
    };
    const initialized = await request("POST", {
      id: 1, method: "initialize",
      params: { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "grosshandel", version: "1.0.0" } },
    });
    const session = initialized.headers.get("Mcp-Session-Id");
    if (session) headers.set("Mcp-Session-Id", session);
    try {
      const handshake = z.object({ protocolVersion: z.literal(protocol) }).parse(await rpcResult(initialized, 1));
      headers.set("MCP-Protocol-Version", handshake.protocolVersion);
      await (await request("POST", { method: "notifications/initialized" })).body?.cancel();
      const reply = await request("POST", {
        id: 2, method: "tools/call", params: { name: "create_cart", arguments: { ...input, delivery_mode: "lieferung" } },
      });
      const result = z.object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      }).parse(await rpcResult(reply, 2));
      if (result.isError) throw new Error("Komander did not create a cart");
      const raw = result.structuredContent ?? JSON.parse(result.content?.find((block) => block.type === "text")?.text ?? "null");
      const cart = checkoutResult.parse(raw);
      const checkout = new URL(cart.checkout_url);
      if (checkout.origin !== store || checkout.username || checkout.password) throw new Error("Unexpected checkout origin");
      return cart;
    } finally {
      if (session) {
        try { await (await request("DELETE")).body?.cancel(); }
        catch { /* A failed session cleanup does not invalidate a checkout link. */ }
      }
    }
  }
}
