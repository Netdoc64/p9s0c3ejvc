import { z } from "zod";
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";

const configSchema = z.object({
  environment: z.enum(["development", "production"]),
  account: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  token: z.string().min(1),
  ordering: z.boolean().default(false),
});

export function flowerShopNetworkConfig(env: Env, tenant: string) {
  try {
    if (!env.FSN_CONNECTIONS) return undefined;
    const connections = JSON.parse(env.FSN_CONNECTIONS) as unknown;
    if (!connections || typeof connections !== "object" || Array.isArray(connections)) throw new Error();
    if (!Object.hasOwn(connections, tenant)) return undefined;
    const config = configSchema.parse((connections as Record<string, unknown>)[tenant]);
    if (config.environment === "production" && env.ENVIRONMENT !== "production") throw new Error();
    return config;
  } catch {
    throw new CodedError("GH-SUPPLIER-001", { reason: "invalid_connection_configuration" });
  }
}

const text = z.string().trim().min(1).max(250);
const state = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const cents = z.number().int().min(0).max(10_000_000);
export const fsnOrderId = z.uuid().transform((id) => id.toLowerCase());
export const fsnProductId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export const fsnFloristQuery = z.object({
  city: text.optional(),
  state: state.optional(),
  zip: z.string().trim().toUpperCase().regex(/^(?:\d{5}|[A-Z]\d[A-Z])$/).optional(),
  order_amount_cents: z.coerce.number().int().min(0).max(10_000_000).optional(),
}).refine((q) => q.zip || (q.city && q.state), "Provide a ZIP or a city and state");

export const fsnOrderInput = z.object({
  id: fsnOrderId,
  sendingFloristContact: text,
  deliveryDate: z.iso.date(),
  recipientFirstName: text,
  recipientLastName: text,
  deliveryAddress1: text,
  deliveryCity: text,
  deliveryState: state,
  deliveryCountry: text.optional(),
  deliveryZipCode: z.string().trim().min(1).max(16),
  attention: text.optional(),
  recipientPhone: z.string().regex(/^\d{10}$/),
  deliverySpecialInstruction: text.optional(),
  cardMessage: z.string().max(1000).optional(),
  priority: text.optional(),
  occasionCode: z.number().int().positive(),
  receivingFloristId: z.string().regex(/^\d{1,20}$/).optional(),
  products: z.array(z.object({ name: text.optional(), description: text, price_cents: cents })).min(1).max(50),
  taxes: z.array(z.object({ label: z.enum(["GST", "HST", "PST", "QST"]), amount_cents: cents })).max(2).default([]),
}).strict().refine((value) => (value.deliveryState === "IT") === !!value.deliveryCountry,
  { path: ["deliveryCountry"], message: "Use a country only for the international IT delivery state" })
  .refine((value) => !value.taxes.length || /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(value.deliveryZipCode),
    { path: ["taxes"], message: "FSN only accepts these taxes for Canadian deliveries" });

const numericId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const orderSummary = z.object({
  id: numericId, status: z.string(), currency: z.string().optional(),
  orderValue: z.string().optional(), dateDelivery: z.string().nullish(),
});
const money = (amount: number) => (amount / 100).toFixed(2);

export class FlowerShopNetworkClient {
  constructor(private readonly config: z.infer<typeof configSchema>, private readonly transport: typeof fetch = fetch) {}

  get account() { return `${this.config.environment}:${this.config.account}`; }
  get orderingEnabled() { return this.config.ordering; }

  private async request(method: string, input: Record<string, unknown> = {}) {
    const host = this.config.environment === "production" ? "api.flowershopnetwork.com" : "dev-api.flowershopnetwork.com";
    const response = await this.transport(`https://${host}/api/${method}`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...input, __token: this.config.token }),
    });
    if (!response.ok) throw new Error("Flower Shop Network HTTP failure");
    const result = z.looseObject({ exception: z.unknown().optional() }).parse(await response.json());
    // Vendor error text can contain order details. Do not propagate it to app logs or clients.
    if (result.exception != null) throw new Error("Flower Shop Network returned an exception");
    return result;
  }

  async product(id: string) {
    const result = await this.request("MyfsnProduct.apiLoadProductData", { productId: id });
    return z.object({
      product: z.object({
        id: z.string(), recipe: z.string().optional(), name: z.string(), description: z.string(),
        imageUrl: z.string().optional(), prices: z.record(z.string(), z.string()),
      }).nullable(),
    }).parse(result);
  }

  async florists({ order_amount_cents, ...q }: z.infer<typeof fsnFloristQuery>) {
    const result = await this.request("RelayUtil.apiSearchFlorists", {
      ...q, ...(order_amount_cents === undefined ? {} : { orderAmount: order_amount_cents / 100 }),
    });
    return z.object({ searchResult: z.array(z.object({
      id: numericId, name: z.string(), city: z.string(), state: z.string(), zip: z.string(),
      preferred: z.boolean().optional(), blocked: z.boolean().optional(), blacklisted: z.boolean().optional(),
    })) }).parse(result);
  }

  payload({ id: _id, products, taxes, ...input }: z.infer<typeof fsnOrderInput>) {
    const amount = products.reduce((sum, item) => sum + item.price_cents, 0)
      + taxes.reduce((sum, item) => sum + item.amount_cents, 0);
    return {
      ...input, totalOrderValue: money(amount),
      products: products.map(({ price_cents, ...item }) => ({ ...item, price: money(price_cents) })),
      ...(taxes.length ? { taxes: taxes.map(({ amount_cents, ...tax }) => ({ ...tax, amount: money(amount_cents) })) } : {}),
    };
  }

  async submit(payload: ReturnType<FlowerShopNetworkClient["payload"]>) {
    return z.object({ id: numericId }).parse(await this.request("RelayOrder.apiSendOrder", payload)).id;
  }

  async status(id: string) {
    const { order } = z.object({ order: orderSummary }).parse(await this.request("RelayOrder.apiGetOrder", { orderId: id }));
    if (order.id !== id) throw new CodedError("GH-SUPPLIER-002");
    return order;
  }
}
