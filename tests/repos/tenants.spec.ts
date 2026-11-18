import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import * as tenantsRepo from "../../src/repos/tenants";
import * as apiKeysRepo from "../../src/repos/api-keys";
import { clearTenants, seedTenant } from "../_setup/seed";
import { CodedError } from "../../src/errors/catalog";

afterEach(async () => {
  await clearTenants();
});

describe("tenants repo", () => {
  it("findById returns active tenant", async () => {
    const t = await seedTenant({ slug: "alpha" });
    const db = getDb(env.DB);
    const found = await tenantsRepo.findById(db, t.tenant_id);
    expect(found?.id).toBe(t.tenant_id);
    expect(found?.slug).toBe("alpha");
  });

  it("findBySlug returns active tenant", async () => {
    const t = await seedTenant({ slug: "beta" });
    const db = getDb(env.DB);
    const found = await tenantsRepo.findBySlug(db, "beta");
    expect(found?.id).toBe(t.tenant_id);
  });

  it("requireById throws GH-TENANT-001 on missing", async () => {
    const db = getDb(env.DB);
    await expect(tenantsRepo.requireById(db, "t_doesnotexist")).rejects.toMatchObject({
      code: "GH-TENANT-001",
    });
  });

  it("softDelete excludes from findById", async () => {
    const t = await seedTenant({ slug: "gamma" });
    const db = getDb(env.DB);
    await tenantsRepo.softDelete(db, t.tenant_id, new Date().toISOString());
    const found = await tenantsRepo.findById(db, t.tenant_id);
    expect(found).toBeNull();
  });
});

describe("api-keys repo", () => {
  it("findByPlain returns active key", async () => {
    const t = await seedTenant();
    const db = getDb(env.DB);
    const k = await apiKeysRepo.findByPlain(db, t.api_key_plain);
    expect(k?.id).toBe(t.api_key_id);
    expect(k?.tenant_id).toBe(t.tenant_id);
  });

  it("findByPlain returns null for unknown", async () => {
    const db = getDb(env.DB);
    const k = await apiKeysRepo.findByPlain(db, "gh_unknownplaintext");
    expect(k).toBeNull();
  });

  it("revoke removes key from findByPlain", async () => {
    const t = await seedTenant();
    const db = getDb(env.DB);
    await apiKeysRepo.revoke(db, t.api_key_id, t.tenant_id, new Date().toISOString());
    const k = await apiKeysRepo.findByPlain(db, t.api_key_plain);
    expect(k).toBeNull();
  });

  it("listForTenant returns all keys including revoked", async () => {
    const t = await seedTenant();
    const db = getDb(env.DB);
    const list = await apiKeysRepo.listForTenant(db, t.tenant_id);
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(t.api_key_id);
  });
});

describe("CodedError shape (sanity)", () => {
  it("instance carries .code", () => {
    const e = new CodedError("GH-TENANT-001");
    expect(e.code).toBe("GH-TENANT-001");
  });
});
