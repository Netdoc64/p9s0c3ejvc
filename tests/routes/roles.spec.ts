import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEmailAdapter, setEmailAdapter } from "../../src/auth/email";
import { randomSecret, sha256Hex } from "../../src/lib/crypto";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const ADMIN = (env as unknown as { ADMIN_API_KEY: string }).ADMIN_API_KEY;
const BASE = "https://example.com";
let t: SeededTenant;
let mails: string[];

beforeEach(async () => {
  t = await seedTenant({ slug: "rol-a" });
  mails = [];
  setEmailAdapter({ async send(m) { mails.push(m.text); } });
});
afterEach(async () => { resetEmailAdapter(); await clearTenants(); });

async function staffToken(role: "owner" | "staff"): Promise<string> {
  const email = `${role}@firma.example`;
  await SELF.fetch(`${BASE}/admin/tenants/rol-a/staff`, { method: "POST", headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
  const h = { "Content-Type": "application/json", "X-Tenant-Slug": "rol-a" };
  await SELF.fetch(`${BASE}/v1/auth/staff/code/request`, { method: "POST", headers: h, body: JSON.stringify({ email }) });
  const code = /Anmelde-Code: (\w{8})/.exec(mails.at(-1) ?? "")?.[1];
  return ((await (await SELF.fetch(`${BASE}/v1/auth/staff/code/verify`, { method: "POST", headers: h, body: JSON.stringify({ email, code }) })).json()) as { access_token: string }).access_token;
}

describe("Rollenmatrix", () => {
  it("einfache Mitarbeiter: keine geldwirksamen Lieferanten-Aufrufe, kein Löschen, kein Massenimport", async () => {
    const tok = await staffToken("staff");
    const h = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    const calls: Array<[string, string]> = [
      ["POST", "/v1/suppliers/floriday/purchase-orders"],
      ["POST", "/v1/suppliers/floriday/purchase-orders/abc/submit"],
      ["POST", "/v1/suppliers/komander/checkout"],
      ["POST", "/v1/suppliers/fleurop-nl/orders"],
      ["POST", "/v1/suppliers/flower-shop-network/orders"],
      ["POST", "/v1/suppliers/imports/lieferant-a"],
      ["POST", "/v1/products/import"],
      ["DELETE", "/v1/products/sku_x"],
      ["DELETE", "/v1/customers/cust_x"],
    ];
    for (const [method, path] of calls) {
      const res = await SELF.fetch(`${BASE}${path}`, { method, headers: h, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Lesen und normale Arbeit bleiben erlaubt
    expect((await SELF.fetch(`${BASE}/v1/customers`, { headers: h })).status).toBe(200);
  });

  it("API-Key mit Scope read darf nur lesen", async () => {
    const plain = `gh_${randomSecret(24)}`;
    const hmac = randomSecret(32);
    await env.DB.prepare("INSERT INTO api_keys (id, tenant_id, key_hash, hmac_secret, name, scope, created_at) VALUES ('k_read', ?, ?, ?, 'lesen', 'read', ?)")
      .bind(t.tenant_id, await sha256Hex(plain), hmac, new Date().toISOString()).run();
    const get = await signedHeaders({ apiKey: plain, hmacSecret: hmac, method: "GET", pathname: "/v1/customers" });
    expect((await SELF.fetch(`${BASE}/v1/customers`, { headers: get })).status).toBe(200);
    const body = JSON.stringify({ name: "X", country: "DE", b2b_b2c: "b2b" });
    const post = await signedHeaders({ apiKey: plain, hmacSecret: hmac, method: "POST", pathname: "/v1/customers", body, idempotencyKey: "r1" });
    expect((await SELF.fetch(`${BASE}/v1/customers`, { method: "POST", headers: post, body })).status).toBe(403);
  });
});
