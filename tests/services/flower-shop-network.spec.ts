import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const base = "/v1/suppliers/flower-shop-network";
const dev = "https://dev-api.flowershopnetwork.com";
const token = "test-token";
const id = "ef58bcef-7b68-4d0b-b40a-10799420ef3c";
const input = {
  id, sendingFloristContact: "Test florist", deliveryDate: "2027-02-12",
  recipientFirstName: "Sample", recipientLastName: "Buyer", deliveryAddress1: "123 Test St.",
  deliveryCity: "Toronto", deliveryState: "ON", deliveryZipCode: "M5V 2T6", recipientPhone: "5551234567",
  occasionCode: 3, products: [{ description: "Bouquet", price_cents: 4999 }], taxes: [{ label: "HST", amount_cents: 650 }],
};

async function setup(ordering = true) {
  const tenant = await seedTenant();
  const other = await seedTenant();
  const config = { environment: "development", account: "florist", token, ordering };
  const bindings = { ...env, FSN_CONNECTIONS: JSON.stringify({ [tenant.tenant_id]: config, [other.tenant_id]: config }) } as unknown as Env;
  const call = async (path: string, value?: unknown, who: SeededTenant = tenant) => {
    const method = value === undefined ? "GET" : "POST";
    const pathname = base + path;
    const body = value === undefined ? undefined : JSON.stringify(value);
    const headers = await signedHeaders({
      apiKey: who.api_key_plain, hmacSecret: who.hmac_secret, method, pathname, ...(body ? { body } : {}),
      ...(body ? { idempotencyKey: crypto.randomUUID() } : {}),
    });
    return worker.fetch(new Request("https://example.com" + pathname, { method, headers, ...(body ? { body } : {}) }), bindings);
  };
  return { call, other };
}

function fsn(method: string, check: (data: Record<string, unknown>) => boolean = () => true) {
  return fetchMock.get(dev).intercept({
    path: "/api/" + method, method: "POST",
    body: (body) => {
      const data = JSON.parse(body as string);
      return data.__token === token && check(data);
    },
  });
}

describe("Flower Shop Network supplier integration", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); }
    finally { fetchMock.deactivate(); }
  });

  it("uses the documented development API for products and florist search", async () => {
    const { call } = await setup(false);
    fsn("MyfsnProduct.apiLoadProductData", (body) => body.productId === "va1").reply(200, {
      product: { id: "va1", name: "Flowers", description: "Roses", prices: { "1": "49.99" } },
    });
    expect(await (await call("/products/va1")).json()).toMatchObject({ product: { id: "va1" } });
    fsn("RelayUtil.apiSearchFlorists", (body) => body.zip === "M5V" && body.orderAmount === 49.99)
      .reply(200, { searchResult: [{ id: 12, name: "Florist", city: "Toronto", state: "ON", zip: "M5V2T6" }] });
    expect(await (await call("/florists?zip=m5v&order_amount_cents=4999")).json())
      .toMatchObject({ searchResult: [{ id: "12" }] });
    expect((await call("/orders", input)).status).toBe(503);
  });

  it("sends once, computes totals from integer cents and limits status to the tenant", async () => {
    const { call, other } = await setup();
    fsn("RelayOrder.apiSendOrder", (body) => body.totalOrderValue === "56.49" &&
      JSON.stringify(body.products) === JSON.stringify([{ description: "Bouquet", price: "49.99" }]) &&
      JSON.stringify(body.taxes) === JSON.stringify([{ label: "HST", amount: "6.50" }]))
      .reply(200, { id: "12345" });
    await Promise.all([call("/orders", input), call("/orders", { ...input, id: id.toUpperCase() })]);
    expect((await call(`/orders/${id}`, undefined, other)).status).toBe(404);
    fsn("RelayOrder.apiGetOrder", (body) => body.orderId === "12345").reply(200, {
      order: { id: "12345", status: "Complete", currency: "CAD", recipient: { firstName: "Excluded" } },
    });
    expect(await (await call(`/orders/${id}`)).json()).toEqual({
      id, status: "submitted", remote_id: "12345", provider_order: { id: "12345", status: "Complete", currency: "CAD" },
    });
  });

  it("does not repeat a submission on a vendor exception", async () => {
    const { call } = await setup();
    fsn("RelayOrder.apiSendOrder").reply(200, { exception: { message: "provider details omitted" } });
    expect(await (await call("/orders", input)).json()).toMatchObject({ status: "unknown" });
    expect(await (await call("/orders", input)).json()).toMatchObject({ status: "unknown" });
  });
});
