import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { parseJsonBody, parseLimit } from "../lib/http";
import { FloridayClient, floridayConfig, purchaseInput, uuid } from "../integrations/floriday";
import { FleuropClient, FleuropError, fleuropAvailability, fleuropConfig, fleuropCosts, fleuropId, fleuropOrder, fleuropProducts, fleuropReconcile } from "../integrations/fleurop";
import { placeFleuropOrder, reconcileFleuropOrder, requireFleuropOrder } from "../integrations/fleurop-orders";
import { FlowerShopNetworkClient, flowerShopNetworkConfig, fsnFloristQuery, fsnOrderId, fsnOrderInput, fsnProductId } from "../integrations/flower-shop-network";
import { getSupplierDispatch, sendSupplierDispatch } from "../integrations/supplier-dispatch";
import { KomanderClient, komanderAvailability, komanderCheckout, komanderConfig, komanderSearch } from "../integrations/komander";
import { supplierList, syncSupplier } from "../integrations/supplier-sync";
import { importSnapshot, listSnapshot, snapshotConnection, snapshotInput, snapshotSku, snapshotSource } from "../integrations/supplier-snapshots";
import { createPurchase, publicOrder, reconcilePurchase, requirePurchase, submitPurchase } from "../integrations/purchase-orders";

export const suppliersRoutes = new Hono<AppContext>();
type RequestContext = import("hono").Context<AppContext>;

function connection(c: RequestContext) {
  const tenantId = c.var.tenant_id;
  if (!tenantId) throw new CodedError("GH-AUTH-001");
  const config = floridayConfig(c.env, tenantId);
  if (!config) throw new CodedError("GH-SUPPLIER-001", { reason: "connection_missing" });
  const client = new FloridayClient(config);
  return { client, key: { tenantId, provider: "floriday", connection: client.connection } };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CodedError("GH-INPUT-001", { issues: result.error.flatten() });
  return result.data;
}

async function supplierCall<T>(run: () => Promise<T>, provider = "floriday"): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CodedError) throw error;
    throw new CodedError("GH-EXT-002", { provider });
  }
}

function fileConnection(c: RequestContext) {
  const tenant = c.var.tenant_id;
  if (!tenant) throw new CodedError("GH-AUTH-001");
  return snapshotConnection(tenant, parse(snapshotSource, c.req.param("source")));
}

suppliersRoutes.post("/imports/:source", async (c) => {
  const key = fileConnection(c);
  const input = parse(snapshotInput, await parseJsonBody(c));
  c.header("Cache-Control", "private, no-store");
  return c.json(await importSnapshot(c.env.DB, key, input));
});

suppliersRoutes.get("/imports/:source", async (c) => {
  const key = fileConnection(c);
  const after = parse(snapshotSku.optional(), c.req.query("after")) ?? "";
  c.header("Cache-Control", "private, no-store");
  return c.json(await listSnapshot(c.env.DB, key, after, parseLimit(c.req.query("limit"))));
});

suppliersRoutes.get("/floriday", (c) => {
  const tenant = c.var.tenant_id;
  if (!tenant) throw new CodedError("GH-AUTH-001");
  const config = floridayConfig(c.env, tenant);
  return c.json({
    enabled: !!config, environment: config?.environment ?? null,
    scheduled: config?.scheduled ?? false, ordering: config?.ordering ?? false,
  });
});

suppliersRoutes.post("/floriday/sync", async (c) => {
  const { client, key } = connection(c);
  return c.json({ streams: await supplierCall(() => syncSupplier(c.env.DB, key, client)) });
});

for (const stream of ["catalog", "offers"] as const) {
  suppliersRoutes.get(`/floriday/${stream}`, async (c) => {
    const { key } = connection(c);
    const after = parse(uuid.optional(), c.req.query("after")) ?? "";
    return c.json(await supplierList(c.env.DB, key, stream, after, parseLimit(c.req.query("limit"))));
  });
}

suppliersRoutes.post("/floriday/purchase-orders", async (c) => {
  const { client, key } = connection(c);
  if (!client.orderingEnabled) throw new CodedError("GH-SUPPLIER-001", { reason: "ordering_disabled" });
  const input = parse(purchaseInput, await parseJsonBody(c));
  return c.json(publicOrder(await createPurchase(c.env.DB, key, input)), 201);
});

suppliersRoutes.get("/floriday/purchase-orders/:id", async (c) => {
  const { key } = connection(c);
  return c.json(publicOrder(await requirePurchase(c.env.DB, key, parse(uuid, c.req.param("id")))));
});

suppliersRoutes.post("/floriday/purchase-orders/:id/submit", async (c) => {
  const { client, key } = connection(c);
  const id = parse(uuid, c.req.param("id"));
  return c.json(publicOrder(await supplierCall(() => submitPurchase(c.env.DB, key, client, id))));
});

suppliersRoutes.post("/floriday/purchase-orders/:id/reconcile", async (c) => {
  const { client, key } = connection(c);
  const id = parse(uuid, c.req.param("id"));
  return c.json(publicOrder(await supplierCall(() => reconcilePurchase(c.env.DB, key, client, id))));
});


function komanderConnection(c: RequestContext) {
  const tenantId = c.var.tenant_id;
  if (!tenantId) throw new CodedError("GH-AUTH-001");
  const config = komanderConfig(c.env, tenantId);
  if (!config) throw new CodedError("GH-SUPPLIER-001", { reason: "connection_missing" });
  return { client: new KomanderClient(config.storeKey), checkoutEnabled: config.checkout };
}

suppliersRoutes.get("/komander/products", async (c) => {
  const { client } = komanderConnection(c);
  const query = parse(komanderSearch, c.req.query());
  return c.json(await supplierCall(() => client.read("products/search", query), "komander"));
});

suppliersRoutes.get("/komander/availability", async (c) => {
  const { client } = komanderConnection(c);
  const query = parse(komanderAvailability, c.req.query());
  return c.json(await supplierCall(() => client.read("availability", query), "komander"));
});

suppliersRoutes.post("/komander/checkout", async (c) => {
  const { client, checkoutEnabled } = komanderConnection(c);
  if (!checkoutEnabled) throw new CodedError("GH-SUPPLIER-001", { reason: "ordering_disabled" });
  const input = parse(komanderCheckout, await parseJsonBody(c));
  const availability = await supplierCall(() => client.read("availability", {
    date: input.delivery_date, postalCode: input.postal_code,
  }), "komander");
  if (availability.available !== true) throw new CodedError("GH-SUPPLIER-003", { reason: "delivery_unavailable" });
  const cart = await supplierCall(() => client.checkout(input), "komander");
  c.header("Cache-Control", "no-store");
  return c.json(cart, 201);
});


function fleuropConnection(c: RequestContext) {
  const tenant = c.var.tenant_id;
  if (!tenant) throw new CodedError("GH-AUTH-001");
  const config = fleuropConfig(c.env, tenant);
  if (!config) throw new CodedError("GH-SUPPLIER-001", { reason: "connection_missing" });
  return { tenant, client: new FleuropClient(config) };
}

suppliersRoutes.get("/fleurop-nl", (c) => {
  const tenant = c.var.tenant_id;
  if (!tenant) throw new CodedError("GH-AUTH-001");
  const config = fleuropConfig(c.env, tenant);
  return c.json({ enabled: !!config, ordering: config?.ordering ?? false });
});

suppliersRoutes.get("/fleurop-nl/products", async (c) => {
  const { client } = fleuropConnection(c);
  const query = parse(fleuropProducts, c.req.query());
  return c.json(await supplierCall(() => client.products(query), "fleurop-nl"));
});

suppliersRoutes.get("/fleurop-nl/availability", async (c) => {
  const { client } = fleuropConnection(c);
  const query = parse(fleuropAvailability, c.req.query());
  c.header("Cache-Control", "no-store");
  return c.json(await supplierCall(() => client.availability(query), "fleurop-nl"));
});

suppliersRoutes.get("/fleurop-nl/delivery-costs", async (c) => {
  const { client } = fleuropConnection(c);
  const query = parse(fleuropCosts, c.req.query());
  c.header("Cache-Control", "no-store");
  return c.json(await supplierCall(() => client.costs(query), "fleurop-nl"));
});

suppliersRoutes.post("/fleurop-nl/orders", async (c) => {
  const { tenant, client } = fleuropConnection(c);
  const input = parse(fleuropOrder, await parseJsonBody(c));
  c.header("Cache-Control", "no-store");
  const order = await placeFleuropOrder(c.env.DB, tenant, client, input);
  return c.json(order, order.status === "sending" ? 202 : 200);
});

suppliersRoutes.get("/fleurop-nl/orders/:id", async (c) => {
  const { tenant, client } = fleuropConnection(c);
  const id = parse(fleuropId, c.req.param("id"));
  c.header("Cache-Control", "no-store");
  return c.json(await requireFleuropOrder(c.env.DB, tenant, client, id));
});

suppliersRoutes.post("/fleurop-nl/orders/:id/reconcile", async (c) => {
  const { tenant, client } = fleuropConnection(c);
  const id = parse(fleuropId, c.req.param("id"));
  const { remote_id } = parse(fleuropReconcile, await parseJsonBody(c));
  c.header("Cache-Control", "no-store");
  return c.json(await supplierCall(async () => {
    try {
      return await reconcileFleuropOrder(c.env.DB, tenant, client, id, remote_id);
    } catch (error) {
      if (error instanceof FleuropError && error.status === 404) throw new CodedError("GH-SUPPLIER-002");
      throw error;
    }
  }, "fleurop-nl"));
});


function fsnConnection(c: RequestContext) {
  const tenant = c.var.tenant_id;
  if (!tenant) throw new CodedError("GH-AUTH-001");
  const config = flowerShopNetworkConfig(c.env, tenant);
  if (!config) throw new CodedError("GH-SUPPLIER-001", { reason: "connection_missing" });
  const client = new FlowerShopNetworkClient(config);
  return { client, scope: { tenant, provider: "flower-shop-network", account: client.account } };
}

suppliersRoutes.get("/flower-shop-network/products/:id", async (c) => {
  const { client } = fsnConnection(c);
  const id = parse(fsnProductId, c.req.param("id"));
  const result = await supplierCall(() => client.product(id), "flower-shop-network");
  if (!result.product) throw new CodedError("GH-SUPPLIER-002");
  return c.json(result);
});

suppliersRoutes.get("/flower-shop-network/florists", async (c) => {
  const { client } = fsnConnection(c);
  const query = parse(fsnFloristQuery, c.req.query());
  return c.json(await supplierCall(() => client.florists(query), "flower-shop-network"));
});

suppliersRoutes.post("/flower-shop-network/orders", async (c) => {
  const { client, scope } = fsnConnection(c);
  if (!client.orderingEnabled) throw new CodedError("GH-SUPPLIER-001", { reason: "ordering_disabled" });
  const input = parse(fsnOrderInput, await parseJsonBody(c));
  const payload = client.payload(input);
  const order = await sendSupplierDispatch(c.env.DB, scope, input.id, JSON.stringify(payload),
    () => client.submit(payload), () => false);
  c.header("Cache-Control", "no-store");
  return c.json(order, order.status === "sending" ? 202 : 200);
});

suppliersRoutes.get("/flower-shop-network/orders/:id", async (c) => {
  const { client, scope } = fsnConnection(c);
  const id = parse(fsnOrderId, c.req.param("id"));
  const order = await getSupplierDispatch(c.env.DB, scope, id);
  const remoteId = order.remote_id;
  const providerOrder = remoteId
    ? await supplierCall(() => client.status(remoteId), "flower-shop-network")
    : null;
  c.header("Cache-Control", "no-store");
  return c.json({ ...order, provider_order: providerOrder });
});
