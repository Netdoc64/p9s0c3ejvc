import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { supplierSyncJob } from "../../src/cron/jobs/supplier-sync";
import type { Env } from "../../src/env";
import { FloridayClient, purchaseInput } from "../../src/integrations/floriday";
import { createPurchase, reconcilePurchase, submitPurchase } from "../../src/integrations/purchase-orders";
import { supplierList, syncSupplier, type SupplierSource } from "../../src/integrations/supplier-sync";
import { seedTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const itemId = "0192e73e-ef5f-71ab-9999-ffffffffffff";
const offerId = "0192e73e-ef5f-71ab-9999-eeeeeeeeeeee";
const supplierId = "0192e73e-ef5f-71ab-9999-dddddddddddd";
const orderId = "0192e73e-ef5f-71ab-9999-cccccccccccc";
const config = {
  environment: "staging" as const, account: "buyer", apiKey: "test-key",
  clientId: "test-client", clientSecret: "test-secret", ordering: true, scheduled: false,
};
const tokenUrl = "https://idm.staging.floriday.io";
const apiUrl = "https://api.staging.floriday.io";
const root = "/customers-api-2026v2";
const packing = {
  piecesPerPackage: 10, package: { vbnPackageCode: 577 }, packagesPerLayer: 2,
  layersPerLoadCarrier: 3, loadCarrierType: "DANISH_TROLLEY", isPrimary: true,
};
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const offer = () => ({
  supplyLineId: offerId, supplierOrganizationId: supplierId, tradeItemId: itemId, sequenceNumber: 7,
  numberOfPieces: 60, isLimited: true, onlyAsapDelivery: false, type: "CATALOG", salesUnit: "PACKAGE",
  isDeleted: false, status: "AVAILABLE", pricePerPiece: { currency: "EUR", value: 0.275 }, volumePrices: [],
  orderPeriod: { startDateTime: hours(-1), endDateTime: hours(2) },
  deliveryPeriod: { startDateTime: hours(1), endDateTime: hours(4) },
});
const item = {
  tradeItemId: itemId, name: "Rose", code: "ROSE-01", vbnProductCode: "1",
  sequenceNumber: 5, isDeleted: false, packingConfigurations: [packing],
};

function oauth() {
  fetchMock.get(tokenUrl).intercept({
    path: "/oauth2/ausmw6b47z1BnlHkw0h7/v1/token", method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret,
      scope: "role:app catalog:read supply:read sales-order:read sales-order:write",
    }).toString(),
  }).reply(200, { access_token: "test-token" });
}

function api(path: string, method = "GET") {
  return fetchMock.get(apiUrl).intercept({
    path: root + path, method, headers: { authorization: "Bearer test-token", "x-api-key": config.apiKey },
  });
}

function mockBootstrap() {
  oauth();
  api("/trade-items/sync/0?limit=250&postFilterSelectedTradeItems=false&postFilterSelectedTradeItemPackingConfigurations=false")
    .reply(200, { maximumSequenceNumber: 5, results: [item] });
  api("/trade-items/sync/5?limit=250&postFilterSelectedTradeItems=false&postFilterSelectedTradeItemPackingConfigurations=false")
    .reply(200, { maximumSequenceNumber: 5, results: [] });
  api("/supply-lines/sync/0?limit=250&postFilterSelectedTradeItems=false")
    .reply(200, { maximumSequenceNumber: 7, results: [offer()] });
  api("/supply-lines/sync/7?limit=250&postFilterSelectedTradeItems=false")
    .reply(200, { maximumSequenceNumber: 7, results: [] });
}

function orderInput() {
  return purchaseInput.parse({
    id: orderId, offer_id: offerId, number_of_pieces: 20,
    expected_price_per_piece: { currency: "EUR", value: 0.275 },
    delivery: { latestDeliveryDateTime: hours(2), location: { gln: "8713783430001" }, incoterm: "DAP" },
    payment_provider: "RFH", reference: "PO-001",
  });
}

const keyFor = (tenantId: string) => ({ tenantId, provider: "floriday", connection: "staging:buyer" });

describe("Floriday supplier integration", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); }
    finally { fetchMock.deactivate(); }
  });

  it("authenticates signed routes, syncs catalog and offers, and isolates tenant data", async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const bindings = {
      ...env, FLORIDAY_CONNECTIONS: JSON.stringify({ [tenant.tenant_id]: config, [other.tenant_id]: config }),
    } as unknown as Env;
    const call = async (path: string, method: string, who = tenant) => {
      const headers = await signedHeaders({
        apiKey: who.api_key_plain, hmacSecret: who.hmac_secret, method, pathname: path,
      });
      return worker.fetch(new Request("https://example.com" + path, { method, headers }), bindings);
    };
    mockBootstrap();
    const synced = await call("/v1/suppliers/floriday/sync", "POST");
    expect(synced.status, await synced.clone().text()).toBe(200);
    expect(await synced.json()).toEqual({ streams: [
      { stream: "catalog", sequence: 5, processed: 1, caught_up: true },
      { stream: "offers", sequence: 7, processed: 1, caught_up: true },
    ] });
    const offers = await call("/v1/suppliers/floriday/offers?limit=1", "GET");
    expect(await offers.json()).toMatchObject({ items: [{ supplyLineId: offerId, article: { name: "Rose" } }], next_after: null });
    const foreign = await call("/v1/suppliers/floriday/offers", "GET", other);
    expect(await foreign.json()).toEqual({ items: [], next_after: null });
    const anonymous = await worker.fetch(new Request("https://example.com/v1/suppliers/floriday/offers"), bindings);
    expect(anonymous.status).toBe(401);
  });

  it("advances empty filtered pages and removes delisted offers without touching internal stock", async () => {
    const { tenant_id } = await seedTenant();
    const key = keyFor(tenant_id);
    mockBootstrap();
    await syncSupplier(env.DB, key, new FloridayClient(config));
    oauth();
    api("/trade-items/sync/5?limit=250&postFilterSelectedTradeItems=false&postFilterSelectedTradeItemPackingConfigurations=false")
      .reply(200, { maximumSequenceNumber: 5, results: [] });
    api("/supply-lines/sync/7?limit=250&postFilterSelectedTradeItems=false")
      .reply(200, { maximumSequenceNumber: 8, results: [] });
    api("/supply-lines/sync/8?limit=250&postFilterSelectedTradeItems=false")
      .reply(200, { maximumSequenceNumber: 9, results: [{ supplyLineId: offerId, sequenceNumber: 9, isDeleted: true }] });
    api("/supply-lines/sync/9?limit=250&postFilterSelectedTradeItems=false")
      .reply(200, { maximumSequenceNumber: 9, results: [] });
    await syncSupplier(env.DB, key, new FloridayClient(config));
    expect((await supplierList(env.DB, key, "offers", "", 10)).items).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM products WHERE tenant_id = ?").bind(tenant_id).first())?.count).toBe(0);
  });

  it("does not advance a stream if the supplier returns an inconsistent page", async () => {
    const { tenant_id } = await seedTenant();
    const key = keyFor(tenant_id);
    const source: SupplierSource = {
      readPage: async (stream) => stream === "catalog"
        ? { sequence: 0, records: [] }
        : { sequence: 2, records: [{ id: offerId, sequence: 3, deleted: false, data: offer() }] },
    };
    await expect(syncSupplier(env.DB, key, source)).rejects.toThrow("sequence");
    expect(await env.DB.prepare("SELECT sequence FROM supplier_sync_state WHERE tenant_id = ? AND stream = 'offers'")
      .bind(tenant_id).first("sequence")).toBe(0);
  });

  it("creates repeatable drafts, sends once on ambiguous results, and reconciles by UUID", async () => {
    const { tenant_id } = await seedTenant();
    const key = keyFor(tenant_id);
    mockBootstrap();
    const client = new FloridayClient(config);
    await syncSupplier(env.DB, key, client);
    const input = orderInput();
    expect((await createPurchase(env.DB, key, input)).status).toBe("draft");
    expect((await createPurchase(env.DB, key, input)).status).toBe("draft");
    await expect(createPurchase(env.DB, key, { ...input, reference: "different" })).rejects.toHaveProperty("code", "GH-SUPPLIER-003");
    api("/sales-orders", "POST").reply(504, {});
    expect((await submitPurchase(env.DB, key, client, orderId)).status).toBe("unknown");
    expect((await submitPurchase(env.DB, key, client, orderId)).status).toBe("unknown");
    api(`/sales-orders/${orderId}`).reply(404, {});
    expect((await reconcilePurchase(env.DB, key, client, orderId)).status).toBe("unknown");
    api(`/sales-orders/${orderId}`).reply(200, { salesOrderId: orderId, status: "ACCEPTED", sequenceNumber: 44 });
    expect(await reconcilePurchase(env.DB, key, client, orderId)).toMatchObject({ status: "submitted", provider_status: "ACCEPTED" });
    api(`/sales-orders/${orderId}`).reply(200, { salesOrderId: orderId, status: "PENDING", sequenceNumber: 42 });
    expect(await reconcilePurchase(env.DB, key, client, orderId)).toMatchObject({ provider_status: "ACCEPTED" });
  });

  it("rejects stale prices and invalid sales units before any order is sent", async () => {
    const { tenant_id } = await seedTenant();
    const key = keyFor(tenant_id);
    mockBootstrap();
    await syncSupplier(env.DB, key, new FloridayClient(config));
    const input = orderInput();
    await expect(createPurchase(env.DB, key, { ...input, number_of_pieces: 9 })).rejects.toHaveProperty("code", "GH-INPUT-001");
    await expect(createPurchase(env.DB, key, { ...input, expected_price_per_piece: { currency: "EUR", value: 0.27 } }))
      .rejects.toHaveProperty("code", "GH-SUPPLIER-003");
    await createPurchase(env.DB, key, input);
    await env.DB.prepare("UPDATE supplier_records SET data = json_set(data, '$.pricePerPiece.value', 0.3) WHERE stream = 'offers'")
      .run();
    await expect(submitPurchase(env.DB, key, new FloridayClient(config), orderId))
      .rejects.toHaveProperty("code", "GH-SUPPLIER-003");
  });

  it("allows only one concurrent submission and reconciles it on the scheduled job", async () => {
    const { tenant_id } = await seedTenant();
    const key = keyFor(tenant_id);
    mockBootstrap();
    const client = new FloridayClient(config);
    await syncSupplier(env.DB, key, client);
    await createPurchase(env.DB, key, orderInput());
    const salesOrders = fetchMock.get(apiUrl);
    salesOrders.intercept({
      path: root + "/sales-orders", method: "POST", headers: { authorization: "Bearer test-token", "x-api-key": config.apiKey },
      body: (serialized) => {
        const request = JSON.parse(serialized as string);
        return request.salesOrderId === orderId && request.supplyLineId === offerId &&
          request.numberOfPieces === 20 && request.pricePerPiece.value === 0.275 &&
          request.packingConfiguration.package.vbnPackageCode === 577;
      },
    }).reply(200, {});
    await Promise.all([
      submitPurchase(env.DB, key, client, orderId),
      submitPurchase(env.DB, key, client, orderId),
    ]);

    oauth();
    api("/trade-items/sync/5?limit=250&postFilterSelectedTradeItems=false&postFilterSelectedTradeItemPackingConfigurations=false")
      .reply(200, { maximumSequenceNumber: 5, results: [] });
    api("/supply-lines/sync/7?limit=250&postFilterSelectedTradeItems=false")
      .reply(200, { maximumSequenceNumber: 7, results: [] });
    api(`/sales-orders/${orderId}`).reply(200, { salesOrderId: orderId, status: "COMMITTED", sequenceNumber: 45 });
    const bindings = {
      ...env, FLORIDAY_CONNECTIONS: JSON.stringify({ [tenant_id]: { ...config, scheduled: true } }),
    } as unknown as Env;
    await supplierSyncJob.handler({ env: bindings, ctx: {} as ExecutionContext, trigger: "cron", run_id: "test" });
    const result = await env.DB.prepare("SELECT provider_status, last_checked_at FROM supplier_purchase_orders WHERE tenant_id = ? AND id = ?")
      .bind(tenant_id, orderId).first();
    expect(result).toMatchObject({ provider_status: "COMMITTED", last_checked_at: expect.any(String) });
  });

});
