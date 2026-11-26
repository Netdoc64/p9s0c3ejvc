import { env } from "cloudflare:test";
import { getDb } from "../../src/db/client";
import { api_keys, tenants } from "../../src/db/schema/tenants";
import { sha256Hex, randomSecret } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";

export interface SeededTenant {
  tenant_id: string;
  api_key_id: string;
  api_key_plain: string;
  hmac_secret: string;
  customer_jwt_secret: string;
  slug: string;
}

let counter = 0;

export async function seedTenant(overrides: Partial<{ slug: string; country: string; currency: string }> = {}): Promise<SeededTenant> {
  counter += 1;
  const slug = overrides.slug ?? `test-tenant-${counter}-${Math.random().toString(36).slice(2, 6)}`;
  const tenant_id = newId("tenant");
  const api_key_id = newId("api_key");
  const api_key_plain = `gh_${randomSecret(24)}`;
  const hmac_secret = randomSecret(32);
  const customer_jwt_secret = randomSecret(32);
  const now = new Date().toISOString();

  const db = getDb(env.DB);
  await db.insert(tenants).values({
    id: tenant_id,
    slug,
    name: `Test Tenant ${counter}`,
    country: overrides.country ?? "NL",
    currency: overrides.currency ?? "EUR",
    customer_jwt_secret,
    status: "active",
    created_at: now,
    updated_at: now,
  });

  await db.insert(api_keys).values({
    id: api_key_id,
    tenant_id,
    key_hash: await sha256Hex(api_key_plain),
    hmac_secret,
    name: "test-key",
    scope: "full",
    created_at: now,
  });

  return { tenant_id, api_key_id, api_key_plain, hmac_secret, customer_jwt_secret, slug };
}

export async function clearTenants(): Promise<void> {
  const db = getDb(env.DB);
  await env.DB.prepare("DELETE FROM api_key_issuances").run();
  await env.DB.prepare("DELETE FROM product_sourcing_state").run();
  await env.DB.prepare("DELETE FROM product_sources").run();
  await env.DB.prepare("DELETE FROM sourcing_rules").run();
  await env.DB.prepare("DELETE FROM tenant_module_credentials").run();
  await env.DB.prepare("DELETE FROM tenant_modules").run();
  await env.DB.prepare("DELETE FROM staff_login_codes").run();
  await env.DB.prepare("DELETE FROM staff_users").run();
  await db.delete(api_keys);
  await db.delete(tenants);
}
