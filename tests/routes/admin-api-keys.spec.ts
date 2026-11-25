import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto";
import { splitIssued } from "../../src/services/api-key-issuance";
import { issueTenantKey } from "../../src/services/api-key-issuance";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const ADMIN = (env as unknown as { ADMIN_API_KEY: string }).ADMIN_API_KEY;
let t: SeededTenant;

beforeEach(async () => {
  t = await seedTenant({ slug: "mint-a" });
});
afterEach(async () => {
  await clearTenants();
});

function mint(slug: string, idem: string, adminKey: string | null = ADMIN) {
  return SELF.fetch(`https://example.com/admin/tenants/${slug}/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idem,
      ...(adminKey === null ? {} : { "X-Admin-Key": adminKey }),
    },
    body: JSON.stringify({ env_var: "GROSSHANDEL_TENANT_KEY", idempotency_key: idem }),
  });
}

async function callTenantApi(value: string): Promise<number> {
  const { api_key, hmac_secret } = splitIssued(value);
  const pathname = "/v1/customers";
  const headers = await signedHeaders({ apiKey: api_key, hmacSecret: hmac_secret, method: "GET", pathname });
  const res = await SELF.fetch(`https://example.com${pathname}`, { headers });
  return res.status;
}

describe("POST /admin/tenants/:slug/api-keys (remote-mint des Business Managers)", () => {
  it("ohne oder mit falschem X-Admin-Key: 401, kein Wert", async () => {
    for (const key of [null, "falsch", `${ADMIN}x`]) {
      const res = await mint("mint-a", `v-${String(key)}`, key);
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.value).toBeUndefined();
    }
  });

  it("gibt einen Wert aus, der als Tenant-Zugang funktioniert, mit passendem Abdruck", async () => {
    const res = await mint("mint-a", "vorgang-1:ziel");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { value: string; fingerprint: string; tenant_id: string; rotated: boolean };
    expect(body.value.length).toBeGreaterThanOrEqual(16);
    expect(body.fingerprint).toBe((await sha256Hex(body.value)).slice(0, 12));
    expect(body.tenant_id).toBe(t.tenant_id);
    expect(body.rotated).toBe(false);
    expect(await callTenantApi(body.value)).toBe(200);
  });

  it("derselbe Idempotency-Key ein zweites Mal: 409 und KEIN Wert", async () => {
    expect((await mint("mint-a", "vorgang-2:ziel")).status).toBe(200);
    const again = await mint("mint-a", "vorgang-2:ziel");
    expect(again.status).toBe(409);
    const body = (await again.json()) as Record<string, unknown>;
    expect(body.value).toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND name = 'business-manager'")
      .bind(t.tenant_id).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("eine neue Ausgabe dreht den Key: der alte gilt in der Karenz weiter, danach nicht mehr", async () => {
    const first = (await (await mint("mint-a", "v-3a")).json()) as { value: string };
    const second = (await (await mint("mint-a", "v-3b")).json()) as { value: string; rotated: boolean };
    expect(second.rotated).toBe(true);
    expect(second.value).not.toBe(first.value);
    expect(await callTenantApi(second.value)).toBe(200);
    expect(await callTenantApi(first.value)).toBe(200);

    // Karenz abgelaufen
    await env.DB.prepare("UPDATE api_keys SET key_hash_previous_until = ?, hmac_secret_previous_until = ? WHERE tenant_id = ? AND name = 'business-manager'")
      .bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", t.tenant_id).run();
    expect(await callTenantApi(first.value)).toBe(401);
    expect(await callTenantApi(second.value)).toBe(200);
  });

  it("der Bootstrap-Key des Tenants bleibt unberührt", async () => {
    await mint("mint-a", "v-4");
    const boot = await env.DB.prepare("SELECT revoked_at, key_hash_previous FROM api_keys WHERE id = ?").bind(t.api_key_id)
      .first<{ revoked_at: string | null; key_hash_previous: string | null }>();
    expect(boot?.revoked_at).toBeNull();
    expect(boot?.key_hash_previous).toBeNull();
  });

  it("unbekannter Tenant: 404; fehlender Idempotency-Key: 400", async () => {
    expect((await mint("gibt-es-nicht", "v-5")).status).toBe(404);
    const res = await SELF.fetch("https://example.com/admin/tenants/mint-a/api-keys", {
      method: "POST",
      headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("ohne ADMIN_API_KEY am Worker ist der Endpunkt aus (503), nicht offen", async () => {
    const { adminRoutes } = await import("../../src/routes/admin");
    const res = await adminRoutes.request("/tenants/mint-a/api-keys", { method: "POST", headers: { "Idempotency-Key": "v-6" } }, { ...env, ADMIN_API_KEY: undefined });
    expect([500, 503]).toContain(res.status);
    const ohne = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_key_issuances WHERE idempotency_key = 'v-6'").first<{ n: number }>();
    expect(ohne?.n).toBe(0);
  });

  it("GET /admin/tenants: Selbstauskunft mit Slug als id, nur mit X-Admin-Key", async () => {
    const ohne = await SELF.fetch("https://example.com/admin/tenants");
    expect(ohne.status).toBe(401);
    const res = await SELF.fetch("https://example.com/admin/tenants", { headers: { "X-Admin-Key": ADMIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenants: Array<Record<string, unknown>> };
    const eintrag = body.tenants.find((x) => x.id === "mint-a");
    expect(eintrag).toMatchObject({ id: "mint-a", status: "active" });
    expect(Object.keys(eintrag ?? {}).sort()).toEqual(["id", "name", "status"]);
  });

  it("zwei gleichzeitige Aufrufe mit demselben Schlüssel: genau einer bekommt einen Wert", async () => {
    const results = await Promise.allSettled([
      issueTenantKey(env as never, "mint-a", "v-7"),
      issueTenantKey(env as never, "mint-a", "v-7"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
