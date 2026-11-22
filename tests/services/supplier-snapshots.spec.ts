import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const root = "/v1/suppliers/imports/";
const offer = {
  sku: "ROSE-01", name: "Rote Rose", unit: "stem", unit_price: "0.275", currency: "EUR",
  available_quantity: 80, minimum_quantity: 10,
};

function client(tenant: Awaited<ReturnType<typeof seedTenant>>) {
  let timestamp = Math.floor(Date.now() / 1000) - 15;
  return async function request(path: string, input?: unknown) {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const method = body === undefined ? "GET" : "POST";
    const pathname = root + path;
    const headers = await signedHeaders({
      method, pathname, body, timestamp: timestamp++,
      apiKey: tenant.api_key_plain, hmacSecret: tenant.hmac_secret,
    });
    return SELF.fetch("https://example.com" + pathname, { method, headers, body });
  };
}

describe("supplier offer snapshots", () => {
  it("imports, paginates and separates snapshots by tenant and source", async () => {
    const request = client(await seedTenant());
    const other = client(await seedTenant());
    const expires_at = new Date(Date.now() + 60_000).toISOString();
    const otherOffer = { ...offer, sku: "ROSE-02" };
    const imported = await request("supplier-a", { revision: 1, expires_at, items: [otherOffer, offer] });
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(await imported.json()).toEqual({ revision: 1, imported: 2, applied: true });

    const page = await request("supplier-a?limit=1");
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await page.json()).toEqual({ revision: 1, expires_at, items: [offer], next_after: offer.sku });
    const next = await request(`supplier-a?limit=1&after=${offer.sku}`);
    expect(await next.json()).toEqual({ revision: 1, expires_at, items: [otherOffer], next_after: null });
    expect((await request("supplier-b")).status).toBe(404);
    expect((await other("supplier-a")).status).toBe(404);
    expect((await SELF.fetch("https://example.com" + root + "supplier-a")).status).toBe(401);
  });

  it("replaces complete snapshots and rejects stale, conflicting or invalid input", async () => {
    const request = client(await seedTenant());
    const first = { revision: 1, expires_at: new Date(Date.now() + 60_000).toISOString(), items: [offer] };
    expect((await request("supplier-a", first)).status).toBe(200);
    expect(await (await request("supplier-a", first)).json()).toMatchObject({ applied: false });
    expect((await request("supplier-a", { ...first, items: [] })).status).toBe(409);
    expect((await request("supplier-a", { ...first, revision: 2, items: [offer, offer] })).status).toBe(400);
    expect((await request("supplier-a", { ...first, revision: 2, items: [] })).status).toBe(200);
    expect((await request("supplier-a", first)).status).toBe(409);
    expect(await (await request("supplier-a")).json()).toMatchObject({ revision: 2, items: [] });
  });

  it("does not present expired inventory as available", async () => {
    const request = client(await seedTenant());
    const expires_at = new Date(Date.now() - 60_000).toISOString();
    expect((await request("supplier-a", { revision: 1, expires_at, items: [offer] })).status).toBe(200);
    expect(await (await request("supplier-a")).json()).toEqual({ revision: 1, expires_at, items: [], next_after: null });
  });
});
