import { z } from "zod";
import { CodedError } from "../errors/catalog";
import type { Env } from "../env";
import { tenantModuleConfig } from "../modules/resolve";
import type { RecordStream, SupplierPage, SupplierSource } from "./supplier-sync";

export const floridayConfigSchema = z.object({
  environment: z.enum(["staging", "production"]),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  apiKey: z.string().min(1),
  // Change this identifier when connecting a different buyer account.
  account: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  scheduled: z.boolean().default(false),
  ordering: z.boolean().default(false),
});
const configSchema = floridayConfigSchema;
type Config = z.infer<typeof configSchema>;

/** Zugänge des Tenants (Modul „floriday“), übergangsweise das alte Sammel-Secret. */
export async function floridayConfig(env: Env, tenantId: string): Promise<Config | undefined> {
  const config = await tenantModuleConfig(env, tenantId, "floriday", configSchema, () => legacyFloridayConfig(env, tenantId));
  if (config?.environment === "production" && env.ENVIRONMENT !== "production") throw new CodedError("GH-SUPPLIER-001", { reason: "invalid_connection_configuration" });
  return config;
}

export function legacyFloridayConfig(env: Env, tenantId: string): Config | undefined {
  try {
    const config = env.FLORIDAY_CONNECTIONS ? JSON.parse(env.FLORIDAY_CONNECTIONS) as unknown : {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    if (!Object.hasOwn(config, tenantId)) return undefined;
    const parsed = configSchema.parse((config as Record<string, unknown>)[tenantId]);
    if (parsed.environment === "production" && env.ENVIRONMENT !== "production") throw new Error();
    return parsed;
  } catch {
    throw new CodedError("GH-SUPPLIER-001", { reason: "invalid_connection_configuration" });
  }
}

const endpoints = {
  staging: {
    api: "https://api.staging.floriday.io/customers-api-2026v2",
    token: "https://idm.staging.floriday.io/oauth2/ausmw6b47z1BnlHkw0h7/v1/token",
  },
  production: {
    api: "https://api.floriday.io/customers-api-2026v2",
    token: "https://idm.floriday.io/oauth2/aus3testdcf2vyfs70i7/v1/token",
  },
};

export const uuid = z.uuid();
const sequence = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
const price = z.object({ currency: z.enum(["EUR", "USD"]), value: z.number().nonnegative() });
const period = z.object({ startDateTime: timestamp, endDateTime: timestamp });
const positiveInt = z.number().int().min(1).max(2_147_483_647);
const packing = z.object({
  piecesPerPackage: positiveInt,
  package: z.object({ vbnPackageCode: z.number().int().min(1).max(999), customPackageId: uuid.nullish() }),
  packagesPerLayer: z.number().int().nonnegative(),
  layersPerLoadCarrier: z.number().int().nonnegative(),
  loadCarrierType: z.string().min(1),
  additionalPricePerPiece: price.nullish(),
  isPrimary: z.boolean().optional(),
}).transform(({ package: { customPackageId, ...pkg }, additionalPricePerPiece, ...p }) => ({
  ...p, package: { ...pkg, ...(customPackageId ? { customPackageId } : {}) },
  ...(additionalPricePerPiece ? { additionalPricePerPiece } : {}),
}));

const activeOffer = z.object({
  supplyLineId: uuid,
  sequenceNumber: sequence,
  isDeleted: z.literal(false),
  supplierOrganizationId: uuid,
  tradeItemId: uuid,
  status: z.literal("AVAILABLE"),
  pricePerPiece: price,
  numberOfPieces: z.number().int().nonnegative(),
  isLimited: z.boolean(),
  onlyAsapDelivery: z.boolean(),
  salesUnit: z.enum(["PIECE", "PACKAGE", "LAYER", "LOAD_CARRIER", "SUPPLY_LINE"]),
  type: z.enum(["UNKNOWN", "CATALOG", "BATCH", "CUSTOMER_OFFER", "PURCHASE_TIP"]),
  orderPeriod: period,
  deliveryPeriod: period.nullish(),
  packingConfigurations: z.array(packing).nullish(),
  volumePrices: z.array(z.object({
    unit: z.enum(["PACKAGE", "LAYER", "LOAD_CARRIER"]),
    pricePerPiece: z.number().nonnegative(),
    minimumQuantity: positiveInt,
  })),
});
const offerChange = z.union([
  z.object({ supplyLineId: uuid, sequenceNumber: sequence, isDeleted: z.literal(true) }),
  z.object({ supplyLineId: uuid, sequenceNumber: sequence, isDeleted: z.literal(false), status: z.literal("UNAVAILABLE") }),
  activeOffer,
]);
const catalogChange = z.union([
  z.object({ tradeItemId: uuid, sequenceNumber: sequence, isDeleted: z.literal(true) }),
  z.object({
    tradeItemId: uuid, sequenceNumber: sequence, isDeleted: z.literal(false),
    code: z.string().nullish(), name: z.string().nullish(), vbnProductCode: z.string(),
    packingConfigurations: z.array(packing).nullish(),
  }),
]);

export type FloridayOffer = z.infer<typeof activeOffer>;
export const purchaseInput = z.object({
  id: uuid,
  offer_id: uuid,
  number_of_pieces: positiveInt,
  packing_index: z.number().int().nonnegative().default(0),
  expected_price_per_piece: price,
  expected_packaging_price_per_piece: price.optional(),
  delivery: z.object({
    deliveryConditionId: uuid.optional(),
    latestDeliveryDateTime: timestamp,
    location: z.object({ gln: z.string().regex(/^\d{13}$/) }),
    incoterm: z.enum(["DDP", "EXW", "DAP", "FCA", "FOB", "CPT", "CIP", "DPU", "FAS", "CFR", "CIF"]),
    nextLegIdentifier: z.string().max(13).optional(),
  }),
  payment_provider: z.enum(["RFH", "VRM", "PLANTION", "FX_SERVICES", "OTHER"]),
  reference: z.string().min(1).max(26),
}).strict();
export type PurchaseInput = z.infer<typeof purchaseInput>;

const remoteOrder = z.object({
  salesOrderId: uuid,
  status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "COMMITTED", "UNFULFILLABLE", "CANCELLED", "EXPIRED"]),
  sequenceNumber: sequence,
});

export class FloridayHttpError extends Error {
  constructor(readonly status: number) {
    super(`Floriday HTTP ${status}`);
  }
}

export class FloridayClient implements SupplierSource {
  private accessToken?: string;
  constructor(private readonly config: Config, private readonly transport: typeof fetch = fetch) {}

  get connection(): string {
    return `${this.config.environment}:${this.config.account}`;
  }

  get orderingEnabled(): boolean {
    return this.config.ordering;
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const response = await this.transport(endpoints[this.config.environment].token, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: "role:app catalog:read supply:read" + (this.config.ordering ? " sales-order:read sales-order:write" : ""),
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new FloridayHttpError(response.status);
    this.accessToken = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
    return this.accessToken;
  }

  private async request(path: string, method = "GET", payload?: string): Promise<Response> {
    const response = await this.transport(`${endpoints[this.config.environment].api}/${path}`, {
      method, redirect: "manual",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "X-Api-Key": this.config.apiKey,
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: payload } : {}),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new FloridayHttpError(response.status);
    return response;
  }

  async readPage(stream: RecordStream, after: number): Promise<SupplierPage> {
    const path = stream === "offers" ? "supply-lines" : "trade-items";
    const query = new URLSearchParams({ limit: "250", postFilterSelectedTradeItems: "false" });
    if (stream === "catalog") query.set("postFilterSelectedTradeItemPackingConfigurations", "false");
    const response = await this.request(`${path}/sync/${after}?${query}`);
    const page = z.object({ maximumSequenceNumber: sequence, results: z.array(z.unknown()) }).parse(await response.json());
    const records = page.results.map((raw) => {
      if (stream === "offers") {
        const value = offerChange.parse(raw);
        return { id: value.supplyLineId, sequence: value.sequenceNumber, deleted: !("pricePerPiece" in value), data: value };
      }
      const value = catalogChange.parse(raw);
      return { id: value.tradeItemId, sequence: value.sequenceNumber, deleted: value.isDeleted, data: value };
    });
    return { sequence: page.maximumSequenceNumber, records };
  }

  async submitOrder(payload: string): Promise<void> {
    await this.request("sales-orders", "POST", payload);
  }

  async prepareOrderSubmission(): Promise<void> {
    await this.token();
  }

  async getOrder(id: string): Promise<z.infer<typeof remoteOrder> | null> {
    await this.token();
    try {
      const response = await this.request(`sales-orders/${id}`);
      const order = remoteOrder.parse(await response.json());
      if (order.salesOrderId !== id) throw new Error("Unexpected sales order ID");
      return order;
    } catch (error) {
      if (error instanceof FloridayHttpError && error.status === 404) return null;
      throw error;
    }
  }
}
