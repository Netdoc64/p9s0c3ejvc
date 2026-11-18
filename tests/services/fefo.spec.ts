import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { stock_batches } from "../../src/db/schema/batches";
import { products } from "../../src/db/schema/products";
import { fefoCheck, assertFefoOk } from "../../src/services/fefo";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { newId } from "../../src/lib/ids";

let tenant: SeededTenant;
const wh = "wh_fefo_test";

beforeEach(async () => {
  tenant = await seedTenant({ slug: "fefo-test" });
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM stock_batches").run();
  await env.DB.prepare("DELETE FROM products").run();
  await clearTenants();
});

async function seedProduct(opts: { is_perishable: boolean; default_shelf_life_days?: number }): Promise<string> {
  const db = getDb(env.DB);
  const id = newId("product");
  const now = new Date().toISOString();
  await db.insert(products).values({
    id,
    tenant_id: tenant.tenant_id,
    sku_code: `SKU-${id.slice(-8)}`,
    name: "Test SKU",
    tax_class: "standard",
    is_perishable: opts.is_perishable ? 1 : 0,
    default_shelf_life_days: opts.default_shelf_life_days ?? null,
    min_order_qty: 1,
    packaging_units: "[]",
    attributes: "{}",
    status: "active",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedBatch(sku_id: string, qty: number, mhd: string | null): Promise<string> {
  const db = getDb(env.DB);
  const id = newId("event");
  const now = new Date().toISOString();
  await db.insert(stock_batches).values({
    id,
    tenant_id: tenant.tenant_id,
    warehouse_id: wh,
    sku_id,
    qty,
    mhd,
    received_at: now,
    status: "active",
    created_at: now,
  });
  return id;
}

describe("FEFO check (perishable)", () => {
  it("returns ok=true when sufficient eligible batches exist (FEFO order)", async () => {
    const sku = await seedProduct({ is_perishable: true });
    const future30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const future60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const oldest = await seedBatch(sku, 50, future30);
    const newest = await seedBatch(sku, 50, future60);

    const r = await fefoCheck(getDb(env.DB), {
      tenant_id: tenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.product_is_perishable).toBe(true);
    expect(r.allocations.length).toBe(1);
    // FEFO: nimmt den ältesten (kleinster mhd) zuerst
    expect(r.allocations[0]?.batch_id).toBe(oldest);
    expect(r.allocations[0]?.qty).toBe(30);
    void newest;
  });

  it("multi-batch allocation when single batch insufficient", async () => {
    const sku = await seedProduct({ is_perishable: true });
    const future30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const future60 = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const b1 = await seedBatch(sku, 30, future30);
    const b2 = await seedBatch(sku, 50, future60);

    const r = await fefoCheck(getDb(env.DB), {
      tenant_id: tenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 60,
    });
    expect(r.ok).toBe(true);
    expect(r.allocations.length).toBe(2);
    expect(r.allocations[0]?.batch_id).toBe(b1);
    expect(r.allocations[0]?.qty).toBe(30);
    expect(r.allocations[1]?.batch_id).toBe(b2);
    expect(r.allocations[1]?.qty).toBe(30);
  });

  it("filters out batches below min_shelf_life_days", async () => {
    const sku = await seedProduct({ is_perishable: true });
    // Tenant default min_shelf_life_days = 3
    const tomorrow = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10); // 1d, < 3d minimum
    const future30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await seedBatch(sku, 100, tomorrow); // gefiltert
    const valid = await seedBatch(sku, 50, future30);

    const r = await fefoCheck(getDb(env.DB), {
      tenant_id: tenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 60,
    });
    expect(r.ok).toBe(false); // 50 valid < 60 requested
    expect(r.total_eligible).toBe(50);
    expect(r.shortfall).toBe(10);
    expect(r.allocations[0]?.batch_id).toBe(valid);
  });

  it("non-perishable products bypass FEFO filter", async () => {
    const sku = await seedProduct({ is_perishable: false });
    await seedBatch(sku, 100, null);
    const r = await fefoCheck(getDb(env.DB), {
      tenant_id: tenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.product_is_perishable).toBe(false);
  });

  it("assertFefoOk wirft GH-FEFO-001 bei shortfall", async () => {
    const sku = await seedProduct({ is_perishable: true });
    await expect(assertFefoOk(getDb(env.DB), {
      tenant_id: tenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 1,
    })).rejects.toMatchObject({ code: "GH-FEFO-001" });
  });

  it("Cross-Tenant: Tenant A's batches sind nicht für Tenant B sichtbar", async () => {
    const sku = await seedProduct({ is_perishable: true });
    const future30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await seedBatch(sku, 100, future30);

    // Anderer Tenant
    const otherTenant = await seedTenant({ slug: "fefo-other" });
    const r = await fefoCheck(getDb(env.DB), {
      tenant_id: otherTenant.tenant_id, warehouse_id: wh, sku_id: sku, qty: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.total_eligible).toBe(0);
  });
});
