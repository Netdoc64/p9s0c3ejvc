import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetViesClient, setViesClient, type ViesClient } from "../../src/services/vies";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

let tenantA: SeededTenant;
let tenantB: SeededTenant;

beforeEach(async () => {
  tenantA = await seedTenant({ slug: "ten-a" });
  tenantB = await seedTenant({ slug: "ten-b" });
});

afterEach(async () => {
  resetViesClient();
  await clearTenants();
  await env.DB.prepare("DELETE FROM customers").run();
});

function viesMock(map: Record<string, "valid" | "invalid" | "unknown">): ViesClient {
  return {
    async validate(_env, vat_id) {
      const status = map[vat_id] ?? "unknown";
      return {
        vat_id,
        status,
        checked_at: new Date().toISOString(),
        cached: false,
        ...(status === "unknown" ? { warning: "vies_unavailable" as const } : {}),
      };
    },
  };
}

async function postCustomer(t: SeededTenant, body: Record<string, unknown>, idempotencyKey: string) {
  const path = "/v1/customers";
  const bodyStr = JSON.stringify(body);
  const headers = await signedHeaders({
    apiKey: t.api_key_plain,
    hmacSecret: t.hmac_secret,
    method: "POST",
    pathname: path,
    body: bodyStr,
    idempotencyKey,
  });
  return SELF.fetch(`https://example.com${path}`, { method: "POST", headers, body: bodyStr });
}

const sampleAddress = {
  line1: "Test 1",
  postal_code: "12345",
  city: "Amsterdam",
  country: "NL",
};

const baseBody = {
  name: "Floraly",
  country: "DE",
  b2b_b2c: "b2b" as const,
  addresses: { billing: sampleAddress },
};

describe("POST /v1/customers", () => {
  it("creates customer without VAT-ID → vat_status='not_required'", async () => {
    setViesClient(viesMock({}));
    const res = await postCustomer(tenantA, baseBody, "k1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vat_status).toBe("not_required");
    expect(body.tenant_id).toBe(tenantA.tenant_id);
  });

  it("creates customer with valid VAT-ID → calls VIES, vat_status='valid'", async () => {
    setViesClient(viesMock({ DE123456789: "valid" }));
    const res = await postCustomer(tenantA, { ...baseBody, vat_id: "DE123456789" }, "k2");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vat_status).toBe("valid");
    expect(body.vies_checked_at).toBeTruthy();
  });

  it("VIES timeout → vat_status='unknown', kein 5xx", async () => {
    setViesClient(viesMock({ DE000000000: "unknown" }));
    const res = await postCustomer(tenantA, { ...baseBody, vat_id: "DE000000000" }, "k3");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vat_status).toBe("unknown");
  });

  it("doppelte VAT-ID → 409 GH-CUST-002", async () => {
    setViesClient(viesMock({ DE123456789: "valid" }));
    await postCustomer(tenantA, { ...baseBody, vat_id: "DE123456789" }, "k4a");
    const res = await postCustomer(tenantA, { ...baseBody, vat_id: "DE123456789" }, "k4b");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-CUST-002");
  });

  it("invalid body → 400 GH-INPUT-001", async () => {
    setViesClient(viesMock({}));
    const res = await postCustomer(tenantA, { name: "X" } as Record<string, unknown>, "k5");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-INPUT-001");
  });
});

describe("Cross-Tenant Isolation", () => {
  it("Tenant-A's customer ist von Tenant-B aus 404", async () => {
    setViesClient(viesMock({}));
    const created = await (await postCustomer(tenantA, baseBody, "x1")).json() as { id: string };

    const headers = await signedHeaders({
      apiKey: tenantB.api_key_plain,
      hmacSecret: tenantB.hmac_secret,
      method: "GET",
      pathname: `/v1/customers/${created.id}`,
    });
    const res = await SELF.fetch(`https://example.com/v1/customers/${created.id}`, { headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-CUST-001");
  });
});

describe("PATCH /v1/customers/:id", () => {
  it("Update VAT-ID re-checked VIES (skipCache)", async () => {
    let calls = 0;
    setViesClient({
      async validate(_env, vat_id, opts) {
        calls += 1;
        return { vat_id, status: "valid", checked_at: new Date().toISOString(), cached: !!opts?.skipCache ? false : true };
      },
    });
    const created = (await (await postCustomer(tenantA, { ...baseBody, vat_id: "DE111" }, "p1")).json()) as { id: string };
    expect(calls).toBe(1);

    const path = `/v1/customers/${created.id}`;
    const bodyStr = JSON.stringify({ vat_id: "DE222" });
    const headers = await signedHeaders({
      apiKey: tenantA.api_key_plain,
      hmacSecret: tenantA.hmac_secret,
      method: "PATCH",
      pathname: path,
      body: bodyStr,
      idempotencyKey: "p2",
    });
    const res = await SELF.fetch(`https://example.com${path}`, { method: "PATCH", headers, body: bodyStr });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
