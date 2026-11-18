import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const origin = "https://aestas.fleurop.nl";
const base = "/v1/suppliers/fleurop-nl";
const providerBase = "/api/v1.0";
const token = "test.fleurop.token";
const config = { bearerToken: token, sender: 11, debtorId: 22, account: "buyer", ordering: true };
const id = "5f131f61-7d1d-4c12-91e5-9e584fd23c6a";
const remote = "d3cd88a1-0a4c-4c7f-afc2-3d19fd86d2c9";
const date = "2027-02-12T09:00:00Z";
const person = { firstname: "Test", lastname: "Buyer", genderCode: "X" };
const input = {
  id, receiver: 33, deliveryDate: date, placer: person,
  addressee: {
    ...person, street: "Teststraat", houseNumber: "12", zipcode: "1012 ab",
    city: "Amsterdam", countryCode: "NL", personTypeCode: "P",
  },
  items: [{ articleCode: "01", quantity: 1, price: 34.95, cardMessage: "Sample card" }],
};

function fleurop(path: string, method = "GET") {
  return fetchMock.get(origin).intercept({ path: providerBase + path, method, headers: { authorization: `Bearer ${token}` } });
}

async function setup(ordering = true) {
  const tenant = await seedTenant();
  const other = await seedTenant();
  const bindings = {
    ...env, FLEUROP_NL_CONNECTIONS: JSON.stringify({
      [tenant.tenant_id]: { ...config, ordering }, [other.tenant_id]: config,
    }),
  } as unknown as Env;
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
  return { call, tenant, other };
}

describe("Fleurop Netherlands supplier integration", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); }
    finally { fetchMock.deactivate(); }
  });

  it("scopes products to the configured debtor and returns availability and quoted costs", async () => {
    const { call } = await setup(false);
    fleurop("/Articles/Search/B2B?DebtorId=22&MemberId=33&IncludeForeign=false&offset=2&limit=5")
      .reply(200, { currentPage: 2, data: [{ id: 123, articleCode: "01", name: "Bouquet" }] });
    expect(await (await call("/products?member_id=33&offset=2&limit=5")).json()).toMatchObject({
      currentPage: 2, data: [{ articleCode: "01" }],
    });

    fleurop("/Members/SearchForDelivery?Zipcode=1012AB&HouseNumber=12&DeliveryDate=2027-02-12T09%3A00%3A00Z&OnlyShowGiftshopDealers=false&offset=1&limit=50")
      .reply(200, { data: [{ memberId: 33, isAvailable: true, city: "Amsterdam" }] });
    expect(await (await call(`/availability?zipcode=1012+ab&house_number=12&delivery_date=${encodeURIComponent(date)}`)).json())
      .toMatchObject({ data: [{ memberId: 33, isAvailable: true }] });

    fleurop("/GetDebtorDeliveryCosts?IsForeignOrder=false&MemberId=33&DebtorId=22&ZipCode=1012AB&HouseNumber=12")
      .reply(200, [{ costs: 500, vatDeliveryCosts: 100 }]);
    expect(await (await call("/delivery-costs?member_id=33&house_number=12&zipcode=1012AB")).json())
      .toEqual([{ costs: 500, vatDeliveryCosts: 100 }]);
    expect((await call("/orders", input)).status).toBe(503);
  });

  it("claims a UUID atomically, sends the specified payload once and stores no delivery data", async () => {
    const { call, tenant, other } = await setup();
    fetchMock.get(origin).intercept({
      path: providerBase + "/Orders", method: "POST", headers: { authorization: `Bearer ${token}` },
      body: (raw) => {
        const order = JSON.parse(raw as string);
        return !("id" in order) && order.clientOrderNumber === id && order.sender === 11 &&
          order.debtorId === 22 && order.addressee.zipcode === "1012AB" && order.items[0].price === 34.95;
      },
    }).reply(201, "", { headers: { Location: providerBase + "/Orders/" + remote } });
    await Promise.all([call("/orders", input), call("/orders", { ...input, id: id.toUpperCase() })]);
    expect(await (await call(`/orders/${id}`)).json()).toEqual({ id, remote_id: remote, status: "submitted" });
    expect((await call(`/orders/${id}`, undefined, other)).status).toBe(404);
    expect((await call("/orders", { ...input, receiver: 44 })).status).toBe(409);
    const row = await env.DB.prepare("SELECT * FROM supplier_dispatches WHERE tenant_id = ?").bind(tenant.tenant_id).first();
    expect(JSON.stringify(row)).not.toMatch(/Teststraat|Sample card|Amsterdam|1012AB/);
  });

  it("accepts documented 201 without a body or location", async () => {
    const { call } = await setup();
    fleurop("/Orders", "POST").reply(201, "");
    expect(await (await call("/orders", input)).json()).toEqual({ id, remote_id: null, status: "submitted" });
  });

  it("reconciles uncertain delivery without sending again and verifies the buyer reference", async () => {
    const { call } = await setup();
    fleurop("/Orders", "POST").reply(504, "");
    expect(await (await call("/orders", input)).json()).toEqual({ id, remote_id: null, status: "unknown" });
    expect(await (await call("/orders", input)).json()).toMatchObject({ status: "unknown" });
    const providerOrder = { orderId: remote, sender: 11, debtorRecId: 22, orderNumber: 63, statusId: "OPEN", deliveryDate: date };
    fleurop(`/Orders/${remote}`).reply(200, { ...providerOrder, clientOrderNumber: "unrelated" });
    expect((await call(`/orders/${id}/reconcile`, { remote_id: remote })).status).toBe(404);
    fleurop(`/Orders/${remote}`).reply(200, { ...providerOrder, clientOrderNumber: id, orderPersons: [{ email: "not-exposed@example.com" }] });
    expect(await (await call(`/orders/${id}/reconcile`, { remote_id: remote })).json()).toEqual({
      id, remote_id: remote, status: "submitted", order_number: 63, provider_status: "OPEN",
      tracking_status: null, delivery_date: date,
    });
  });
});
