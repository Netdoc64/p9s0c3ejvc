import { z } from "zod";
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";

const origin = "https://aestas.fleurop.nl";
const memberId = z.number().int().min(1).max(99999);
const int32 = z.number().int().min(1).max(2147483647);
export const fleuropId = z.uuid().transform((id) => id.toLowerCase());
const dateTime = z.iso.datetime({ offset: true });
const zip = z.string().trim().toUpperCase().regex(/^\d{4} ?[A-Z]{2}$/).transform((s) => s.replace(" ", ""));
const configSchema = z.object({
  account: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  bearerToken: z.string().min(1).regex(/^[A-Za-z0-9._~-]+$/),
  sender: memberId,
  debtorId: int32,
  ordering: z.boolean().default(false),
});

export function fleuropConfig(env: Env, tenantId: string) {
  try {
    if (!env.FLEUROP_NL_CONNECTIONS) return undefined;
    const config = JSON.parse(env.FLEUROP_NL_CONNECTIONS) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return Object.hasOwn(config, tenantId) ? configSchema.parse((config as Record<string, unknown>)[tenantId]) : undefined;
  } catch {
    throw new CodedError("GH-SUPPLIER-001", { reason: "invalid_connection_configuration" });
  }
}

const page = {
  offset: z.coerce.number().int().min(1).max(2147483647).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
const memberQuery = z.coerce.number().int().min(1).max(99999).optional();
export const fleuropProducts = z.object({ ...page, member_id: memberQuery });
export const fleuropAvailability = z.object({
  ...page, zipcode: zip, house_number: z.coerce.number().int().positive().max(2147483647),
  delivery_date: dateTime, delivery_time: z.string().min(1).max(30).optional(),
});
export const fleuropCosts = z.object({
  zipcode: zip, house_number: z.string().trim().regex(/^\d{1,5}$/),
  member_id: z.coerce.number().int().min(1).max(99999),
});
const person = z.object({
  firstname: z.string().min(1).max(15), lastname: z.string().min(1).max(20),
  genderCode: z.string().min(1).max(20), email: z.email().optional(),
  phonePrivate: z.string().max(25).optional(), companyName: z.string().max(40).optional(),
});
export const fleuropOrder = z.object({
  id: fleuropId,
  receiver: memberId,
  deliveryDate: dateTime,
  deliveryTime: z.string().max(30).optional(),
  placer: person,
  addressee: person.extend({
    street: z.string().min(1).max(100), houseNumber: z.string().regex(/^\d{1,5}$/),
    suffix: z.string().max(5).optional(), zipcode: zip, city: z.string().min(1).max(100),
    countryCode: z.literal("NL"), personTypeCode: z.string().min(1).max(20),
  }),
  items: z.array(z.object({
    articleCode: z.string().min(1).max(10), quantity: z.number().int().min(1).max(9999),
    price: z.number().nonnegative(), remark: z.string().max(75).optional(), cardMessage: z.string().max(250).optional(),
  })).min(1).max(50),
  remarkReceiver: z.string().max(255).optional(),
  deliverAtNeighbours: z.boolean().optional(),
}).strict();
export const fleuropReconcile = z.object({ remote_id: fleuropId }).strict();

export class FleuropError extends Error {
  constructor(readonly status: number) { super(`Fleurop HTTP ${status}`); }
}

function resultPage<T>(schema: z.ZodType<T>) {
  return z.object({
    currentPage: z.number().int().optional(), pageCount: z.number().int().optional(),
    pageSize: z.number().int().optional(), rowCount: z.number().int().optional(),
    data: z.array(schema).nullish(),
  }).transform((result) => ({ ...result, data: result.data ?? [] }));
}

const article = z.looseObject({ id: int32, articleCode: z.string().nullish() });
const member = z.object({
  memberId, name1: z.string().nullish(), name2: z.string().nullish(),
  city: z.string().nullish(), isAvailable: z.boolean(), reasonNotavailable: z.string().nullish(),
});
const order = z.object({
  orderId: fleuropId, sender: memberId, debtorRecId: int32.nullish(),
  clientOrderNumber: z.string().nullish(), orderNumber: z.number().int().nullish(),
  statusId: z.string().nullish(), ttStatusId: z.string().nullish(), deliveryDate: z.string().nullish(),
});

export class FleuropClient {
  constructor(private readonly config: z.infer<typeof configSchema>, private readonly transport: typeof fetch = fetch) {}

  get account() { return this.config.account; }
  get orderingEnabled() { return this.config.ordering; }

  private async request(path: string, query?: Record<string, string | number | boolean | undefined>, body?: string) {
    const url = new URL(`/api/v1.0/${path}`, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.transport(url.toString(), {
      method: body ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${this.config.bearerToken}`, Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new FleuropError(response.status);
    return response;
  }

  async products(q: z.infer<typeof fleuropProducts>) {
    const response = await this.request("Articles/Search/B2B", {
      DebtorId: this.config.debtorId, MemberId: q.member_id, IncludeForeign: false, offset: q.offset, limit: q.limit,
    });
    return resultPage(article).parse(await response.json());
  }

  async availability(q: z.infer<typeof fleuropAvailability>) {
    const response = await this.request("Members/SearchForDelivery", {
      Zipcode: q.zipcode, HouseNumber: q.house_number, DeliveryDate: q.delivery_date,
      DeliveryTime: q.delivery_time, OnlyShowGiftshopDealers: false, offset: q.offset, limit: q.limit,
    });
    return resultPage(member).parse(await response.json());
  }

  async costs(q: z.infer<typeof fleuropCosts>) {
    const response = await this.request("GetDebtorDeliveryCosts", {
      IsForeignOrder: false, MemberId: q.member_id, DebtorId: this.config.debtorId,
      ZipCode: q.zipcode, HouseNumber: q.house_number,
    });
    return z.array(z.object({ costs: z.number().int(), vatDeliveryCosts: z.number().int() })).parse(await response.json());
  }

  payload(input: z.infer<typeof fleuropOrder>) {
    const { id, ...payload } = input;
    return JSON.stringify({ ...payload, clientOrderNumber: id, sender: this.config.sender, debtorId: this.config.debtorId });
  }

  async submit(payload: string): Promise<string | null> {
    const response = await this.request("Orders", undefined, payload);
    if (response.status !== 201) throw new Error("Unexpected Fleurop create response");
    const location = response.headers.get("Location");
    if (response.body) await response.body.cancel();
    if (!location) return null;
    try {
      const url = new URL(location, origin);
      if (url.origin !== origin) return null;
      const parsed = fleuropId.safeParse(url.pathname.match(/^\/api\/v1\.0\/Orders\/([^/]+)\/?$/i)?.[1]);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async status(remoteId: string, localId: string) {
    const response = await this.request(`Orders/${encodeURIComponent(remoteId)}`);
    const result = order.parse(await response.json());
    if (result.orderId.toLowerCase() !== remoteId.toLowerCase() ||
        result.sender !== this.config.sender ||
        (result.debtorRecId != null && result.debtorRecId !== this.config.debtorId) ||
        result.clientOrderNumber?.toLowerCase() !== localId.toLowerCase()) {
      throw new CodedError("GH-SUPPLIER-002");
    }
    return {
      order_number: result.orderNumber ?? null, provider_status: result.statusId ?? null,
      tracking_status: result.ttStatusId ?? null, delivery_date: result.deliveryDate ?? null,
    };
  }
}
