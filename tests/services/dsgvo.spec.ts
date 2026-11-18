import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { customers } from "../../src/db/schema/customers";
import { pseudonymizeCustomer } from "../../src/services/dsgvo";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { newId } from "../../src/lib/ids";
import { CodedError } from "../../src/errors/catalog";

let tenant: SeededTenant;

beforeEach(async () => {
  tenant = await seedTenant({ slug: "dsgvo-test" });
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM customers").run();
  await clearTenants();
});

async function seedCustomer(): Promise<string> {
  const id = newId("customer");
  const now = new Date().toISOString();
  await getDb(env.DB).insert(customers).values({
    id,
    tenant_id: tenant.tenant_id,
    name: "Hannes Mustermann",
    email: "hannes@example.com",
    phone: "+49 30 12345678",
    country: "DE",
    b2b_b2c: "b2b",
    vat_id: "DE123456789",
    vat_status: "valid",
    addresses: JSON.stringify({
      billing: { line1: "Friedrichstrasse 1", postal_code: "10117", city: "Berlin", country: "DE" },
    }),
    metadata: "{}",
    created_at: now,
    updated_at: now,
  });
  return id;
}

describe("DSGVO Pseudonymisierung", () => {
  it("ersetzt name/email/phone durch sha256-Tags", async () => {
    const id = await seedCustomer();
    const r = await pseudonymizeCustomer(getDb(env.DB), {
      tenant_id: tenant.tenant_id,
      customer_id: id,
      reason: "DSGVO-Antrag-2026-001",
      actor_id: "k_admin",
    });
    expect(r.fields_replaced).toContain("name");
    expect(r.fields_replaced).toContain("email");
    expect(r.fields_replaced).toContain("phone");
    expect(r.fields_replaced).toContain("addresses");

    const after = (await getDb(env.DB).select().from(customers).where(eq(customers.id, id)).limit(1))[0];
    expect(after?.name).toMatch(/^<sha256:[0-9a-f]+>$/);
    expect(after?.email).toMatch(/^<sha256:[0-9a-f]+>$/);
    expect(after?.phone).toMatch(/^<sha256:[0-9a-f]+>$/);
    expect(after?.deleted_at).toBeTruthy();
  });

  it("behält country + postal_code in addresses (Steuer-Audit)", async () => {
    const id = await seedCustomer();
    await pseudonymizeCustomer(getDb(env.DB), { tenant_id: tenant.tenant_id, customer_id: id, reason: "test" });
    const after = (await getDb(env.DB).select().from(customers).where(eq(customers.id, id)).limit(1))[0];
    const addr = JSON.parse(after?.addresses ?? "{}") as { billing?: Record<string, unknown> };
    expect(addr.billing?.country).toBe("DE");
    expect(addr.billing?.postal_code).toBe("10117");
    expect(addr.billing?.line1).toMatch(/^<sha256:/);
    expect(addr.billing?.city).toMatch(/^<sha256:/);
  });

  it("Audit-Log in metadata.dsgvo[]", async () => {
    const id = await seedCustomer();
    await pseudonymizeCustomer(getDb(env.DB), {
      tenant_id: tenant.tenant_id, customer_id: id, reason: "request-001", actor_id: "k_admin",
    });
    const after = (await getDb(env.DB).select().from(customers).where(eq(customers.id, id)).limit(1))[0];
    const meta = JSON.parse(after?.metadata ?? "{}") as { dsgvo?: Array<Record<string, unknown>>; pseudonymized_at?: string };
    expect(meta.dsgvo?.[0]?.reason).toBe("request-001");
    expect(meta.dsgvo?.[0]?.actor_id).toBe("k_admin");
    expect(meta.pseudonymized_at).toBeTruthy();
  });

  it("hash ist deterministic — gleicher input → gleicher tag", async () => {
    const id1 = await seedCustomer();
    const id2 = newId("customer");
    const now = new Date().toISOString();
    // Zweiter Customer mit identischer Email
    await getDb(env.DB).insert(customers).values({
      id: id2, tenant_id: tenant.tenant_id, name: "Jemand Anderes",
      email: "hannes@example.com", country: "DE", b2b_b2c: "b2b",
      vat_status: "not_required",
      addresses: '{"billing":{"line1":"x","postal_code":"1","city":"x","country":"DE"}}',
      metadata: "{}", created_at: now, updated_at: now,
    });

    await pseudonymizeCustomer(getDb(env.DB), { tenant_id: tenant.tenant_id, customer_id: id1, reason: "x" });
    await pseudonymizeCustomer(getDb(env.DB), { tenant_id: tenant.tenant_id, customer_id: id2, reason: "y" });
    const a = (await getDb(env.DB).select().from(customers).where(eq(customers.id, id1)).limit(1))[0];
    const b = (await getDb(env.DB).select().from(customers).where(eq(customers.id, id2)).limit(1))[0];
    expect(a?.email).toBe(b?.email); // gleicher Hash → Korrelation möglich
    expect(a?.name).not.toBe(b?.name); // verschiedene Namen → verschiedene Hashes
  });

  it("Cross-Tenant: Customer von Tenant-A kann von Tenant-B aus nicht pseudonymisiert werden", async () => {
    const id = await seedCustomer();
    const otherTenant = await seedTenant({ slug: "dsgvo-other" });
    await expect(pseudonymizeCustomer(getDb(env.DB), {
      tenant_id: otherTenant.tenant_id, customer_id: id, reason: "x",
    })).rejects.toMatchObject({ code: "GH-CUST-001" });
  });

  it("Customer existiert nicht → GH-CUST-001", async () => {
    const e = await pseudonymizeCustomer(getDb(env.DB), {
      tenant_id: tenant.tenant_id, customer_id: "cust_doesnotexist", reason: "x",
    }).catch((err) => err);
    expect(e).toBeInstanceOf(CodedError);
    expect((e as CodedError).code).toBe("GH-CUST-001");
  });
});
