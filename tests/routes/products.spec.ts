import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

let tenant: SeededTenant;

beforeEach(async () => {
  tenant = await seedTenant({ slug: "ten-prod" });
});

afterEach(async () => {
  await env.DB.prepare("DELETE FROM product_images").run();
  await env.DB.prepare("DELETE FROM products").run();
  await clearTenants();
});

async function send(method: string, pathname: string, body?: unknown, idempotencyKey = "k", contentType?: string) {
  const bodyStr = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const extra: Record<string, string> = {};
  if (contentType) extra["Content-Type"] = contentType;
  const headers = await signedHeaders({
    apiKey: tenant.api_key_plain,
    hmacSecret: tenant.hmac_secret,
    method,
    pathname,
    body: bodyStr,
    idempotencyKey: method === "GET" ? undefined : idempotencyKey,
    extraHeaders: extra,
  });
  return SELF.fetch(`https://example.com${pathname}`, {
    method,
    headers,
    body: method === "GET" ? undefined : bodyStr,
  });
}

const baseProduct = {
  sku_code: "ROSE-NAOMI-60",
  name: "Rose Naomi 60cm",
  tax_class: "standard" as const,
  packaging_units: [{ name: "carton", contains: 50, unit_of_inner: "stem" }],
  attributes: { variety: "Naomi", length_cm: 60, color: "red" },
};

describe("products CRUD", () => {
  it("creates and reads", async () => {
    const r = await send("POST", "/v1/products", baseProduct, "p1");
    expect(r.status).toBe(201);
    const created = (await r.json()) as { id: string; name: string };
    expect(created.id).toMatch(/^sku_/);

    const g = await send("GET", `/v1/products/${created.id}`);
    expect(g.status).toBe(200);
  });

  it("duplicate sku_code → 404 GH-PROD-001 with reason", async () => {
    await send("POST", "/v1/products", baseProduct, "p2a");
    const r = await send("POST", "/v1/products", baseProduct, "p2b");
    expect(r.status).toBe(404);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-PROD-001");
  });

  it("search finds by name token", async () => {
    await send("POST", "/v1/products", baseProduct, "p3a");
    const r = await send("GET", `/v1/products/search?q=naomi`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ name: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.name).toContain("Naomi");
  });
});

describe("CSV import", () => {
  it("imports valid CSV with multiple rows", async () => {
    const csv = [
      "sku_code,name,tax_class,is_perishable,min_order_qty,packaging_units,attributes",
      `TULIP-RED-40,Tulip Red 40cm,standard,true,1,"[{""name"":""carton"",""contains"":50,""unit_of_inner"":""stem""}]","{""color"":""red""}"`,
      `TULIP-WHITE-40,Tulip White 40cm,standard,true,1,"[]","{}"`,
      `BAD-ROW,,standard,false,1,"[]","{}"`,
    ].join("\n");
    const r = await send("POST", "/v1/products/import", csv, "imp1", "text/csv");
    expect(r.status).toBe(200);
    const report = (await r.json()) as { imported_ok: number; imported_failed: Array<unknown> };
    expect(report.imported_ok).toBe(2);
    expect(report.imported_failed.length).toBe(1);
  });
});

describe("Produktbilder", () => {
  // Bis 2026-11-17 übersprungen („binary HMAC edge case“). Der Fehler lag im
  // Test: er signierte das PNG als Latin-1-String, der beim Hashen als UTF-8
  // kodiert wurde — andere Bytes als gesendet. signedHeaders nimmt Uint8Array.
  async function upload(): Promise<{ productId: string; image_id: string; r2_key: string; bytes: number }> {
    const created = (await (await send("POST", "/v1/products", baseProduct, `img-p-${Math.random()}`)).json()) as { id: string };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const path = `/v1/products/${created.id}/images`;
    const headers = await signedHeaders({
      apiKey: tenant.api_key_plain,
      hmacSecret: tenant.hmac_secret,
      method: "POST",
      pathname: path,
      body: png,
      idempotencyKey: `img-${Math.random()}`,
      extraHeaders: { "Content-Type": "image/png" },
    });
    const r = await SELF.fetch(`https://example.com${path}`, { method: "POST", headers, body: png });
    expect(r.status).toBe(201);
    return { productId: created.id, ...(await r.json() as { image_id: string; r2_key: string; bytes: number }) };
  }

  it("speichert ein PNG in R2 und legt die Zeile an", async () => {
    const up = await upload();
    expect(up.bytes).toBe(8);
    const obj = await env.ASSETS.get(up.r2_key);
    expect(obj).toBeTruthy();
    // Body lesen: ein offener R2-Stream lässt das isolierte Test-Storage scheitern.
    expect((await obj!.arrayBuffer()).byteLength).toBe(8);
  });

  it("liefert das Bild öffentlich und unveränderlich cachebar aus", async () => {
    const up = await upload();
    const r = await SELF.fetch(`https://example.com/v1/public/product-images/${up.image_id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(r.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await r.arrayBuffer())[1]).toBe(0x50);
  });

  it("eine unbekannte Bild-ID ist 404", async () => {
    const r = await SELF.fetch("https://example.com/v1/public/product-images/evt_00000000000000000000000000");
    expect(r.status).toBe(404);
  });
});
