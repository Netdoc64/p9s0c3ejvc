import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { seedTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const shop = "https://blumen-verschicken.online";
const mcp = "https://mcp.blumen-verschicken.online";
const apiKey = "public-test-stub";
const date = "2027-02-12";

async function setup(checkout = true) {
  const tenant = await seedTenant();
  const bindings = {
    ...env, KOMANDER_CONNECTIONS: JSON.stringify({ [tenant.tenant_id]: { storeKey: apiKey, checkout } }),
  } as unknown as Env;
  return async (path: string, data?: unknown) => {
    const method = data === undefined ? "GET" : "POST";
    const pathname = "/v1/suppliers/komander" + path;
    const body = data === undefined ? undefined : JSON.stringify(data);
    const headers = await signedHeaders({
      apiKey: tenant.api_key_plain, hmacSecret: tenant.hmac_secret, method, pathname, ...(body ? { body } : {}),
    });
    return worker.fetch(new Request("https://example.com" + pathname, { method, headers, ...(body ? { body } : {}) }), bindings);
  };
}

const input = {
  variant_id: "var_TEST", delivery_date: date, first_name: "Max", last_name: "Test",
  address_1: "Teststr. 1", postal_code: "80799", email: "test@example.com",
};

function availability(available: boolean) {
  fetchMock.get(shop).intercept({
    path: `/store/availability?date=${date}&postalCode=80799`, headers: { "x-publishable-api-key": apiKey },
  }).reply(200, { available });
}

function checkoutResponse(url: string) {
  const server = fetchMock.get(mcp);
  server.intercept({
    path: "/mcp", method: "POST",
    body: /"method":"initialize"/,
  }).reply(200, "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }) + "\n\n", {
    headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "test-session" },
  });
  const headers = { "mcp-session-id": "test-session", "mcp-protocol-version": "2025-03-26" };
  server.intercept({ path: "/mcp", method: "POST", headers, body: /"method":"notifications\/initialized"/ }).reply(202, "");
  server.intercept({
    path: "/mcp", method: "POST", headers,
    body: (body) => {
      const rpc = JSON.parse(body as string);
      return rpc.method === "tools/call" && rpc.params.name === "create_cart" && rpc.params.arguments.delivery_mode === "lieferung";
    },
  }).reply(200, { jsonrpc: "2.0", id: 2, result: {
    content: [{ type: "text", text: JSON.stringify({ cart_id: "cart_test", checkout_url: url }) }],
  } }, { headers: { "Content-Type": "application/json" } });
  server.intercept({ path: "/mcp", method: "DELETE", headers }).reply(204, "");
}

describe("Komander sales channel", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); }
    finally { fetchMock.deactivate(); }
  });

  it("returns product and availability data without a checkout", async () => {
    const call = await setup(false);
    fetchMock.get(shop).intercept({
      path: "/store/products/search?occasion=geburtstag&maxPrice=60",
      headers: { "x-publishable-api-key": apiKey },
    }).reply(200, { products: [{ id: "prod_test", title: "Strauß" }] });
    const products = await call("/products?occasion=geburtstag&maxPrice=60");
    expect(await products.json()).toEqual({ products: [{ id: "prod_test", title: "Strauß" }] });
    availability(true);
    expect(await (await call(`/availability?date=${date}&postalCode=80799`)).json()).toEqual({ available: true });
    expect((await call("/checkout", input)).status).toBe(503);
  });

  it("writes no cart when the address is unavailable", async () => {
    const call = await setup();
    availability(false);
    expect((await call("/checkout", input)).status).toBe(409);
  });

  it("prepares a cart and hands off to the seller's checkout", async () => {
    const call = await setup();
    availability(true);
    checkoutResponse(shop + "/checkout/cart_test");
    const response = await call("/checkout", input);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ cart_id: "cart_test", checkout_url: shop + "/checkout/cart_test" });
  });

  it("rejects a checkout link on another origin", async () => {
    const call = await setup();
    availability(true);
    checkoutResponse("https://elsewhere.example/checkout");
    expect((await call("/checkout", input)).status).toBe(502);
  });
});
