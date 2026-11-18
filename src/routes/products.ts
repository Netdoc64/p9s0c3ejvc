import { Hono } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import * as productsRepo from "../repos/products";
import { ProductCreateSchema, ProductPatchSchema } from "../schemas/product";
import { newId } from "../lib/ids";
import { sha256Hex } from "../lib/crypto";
import { importCsvStream } from "../services/catalog-import";
import { product_images } from "../db/schema/products";
import { parseCursor, parseLimit, signCursor } from "../lib/http";

export const productsRoutes = new Hono<AppContext>();

function tenantId(c: import("hono").Context<AppContext>): string {
  const t = c.var.tenant_id;
  if (!t) throw new CodedError("GH-AUTH-001");
  return t;
}

function sanitize<T extends { packaging_units: string; attributes: string }>(p: T): T & { packaging_units: unknown; attributes: unknown } {
  return { ...p, packaging_units: JSON.parse(p.packaging_units), attributes: JSON.parse(p.attributes) };
}

productsRoutes.post("/", async (c) => {
  const tenant_id = tenantId(c);
  const body = await c.req.json();
  const parsed = ProductCreateSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const existing = await productsRepo.findBySkuCode(db, tenant_id, parsed.data.sku_code);
  if (existing) throw new CodedError("GH-PROD-001", { existing_sku_id: existing.id, reason: "duplicate sku_code" });

  if (parsed.data.parent_sku_id) {
    await productsRepo.requireById(db, tenant_id, parsed.data.parent_sku_id);
  }

  const now = new Date().toISOString();
  const row = await productsRepo.create(db, {
    id: newId("product"),
    tenant_id,
    sku_code: parsed.data.sku_code,
    parent_sku_id: parsed.data.parent_sku_id ?? null,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    tax_class: parsed.data.tax_class,
    is_perishable: parsed.data.is_perishable ? 1 : 0,
    default_shelf_life_days: parsed.data.default_shelf_life_days ?? null,
    min_order_qty: parsed.data.min_order_qty,
    packaging_units: JSON.stringify(parsed.data.packaging_units),
    attributes: JSON.stringify(parsed.data.attributes),
    status: "active",
    created_at: now,
    updated_at: now,
  });
  return c.json(sanitize(row), 201);
});

productsRoutes.get("/search", async (c) => {
  const tenant_id = tenantId(c);
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return c.json({ items: [] });
  const db = getDb(c.env.DB);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const rows = await productsRepo.search(db, tenant_id, q, limit);
  return c.json({ items: rows.map(sanitize) });
});

productsRoutes.get("/", async (c) => {
  const tenant_id = tenantId(c);
  const db = getDb(c.env.DB);
  const limit = parseLimit(c.req.query("limit"));
  const cursor = await parseCursor(c.env, c.req.query("cursor"));
  const rows = await productsRepo.list(db, tenant_id, { cursor, limit });
  const last = rows[rows.length - 1];
  const next = rows.length === limit && last ? await signCursor(c.env, { created_at: last.created_at, id: last.id }) : null;
  return c.json({ items: rows.map(sanitize), next_cursor: next });
});

productsRoutes.get("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const row = await productsRepo.requireById(db, tenant_id, id);
  return c.json(sanitize(row));
});

productsRoutes.patch("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = ProductPatchSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  await productsRepo.requireById(db, tenant_id, id);

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (k === "packaging_units" || k === "attributes") patch[k] = JSON.stringify(v);
    else if (k === "is_perishable") patch[k] = v ? 1 : 0;
    else patch[k] = v;
  }
  const updated = await productsRepo.update(db, tenant_id, id, patch);
  return c.json(sanitize(updated));
});

productsRoutes.delete("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  await productsRepo.requireById(db, tenant_id, id);
  await productsRepo.softDelete(db, tenant_id, id);
  return c.body(null, 204);
});

productsRoutes.post("/import", async (c) => {
  const tenant_id = tenantId(c);
  const body = c.req.raw.body;
  if (!body) throw new CodedError("GH-INPUT-001", { reason: "missing body" });
  const db = getDb(c.env.DB);
  const report = await importCsvStream(db, tenant_id, body);
  return c.json(report);
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

productsRoutes.post("/:id/images", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  await productsRepo.requireById(db, tenant_id, id);

  const ct = c.req.header("Content-Type") ?? "application/octet-stream";
  // Whitelist (#T-006): kein SVG (XSS bei Browser-Render), keine Path-Traversal über Content-Type.
  const ALLOWED: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ctClean = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = ALLOWED[ctClean];
  if (!ext) throw new CodedError("GH-INPUT-001", { reason: `unsupported content-type: ${ctClean}` });
  const buf = await c.req.raw.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new CodedError("GH-INPUT-002");

  const hash = await sha256Hex(new Uint8Array(buf));
  const r2_key = `${tenant_id}/products/${id}/${hash}.${ext}`;
  await c.env.ASSETS.put(r2_key, buf, { httpMetadata: { contentType: ctClean }, customMetadata: { tenant_id, sku_id: id } });

  const image_id = newId("event");
  const now = new Date().toISOString();
  await db.insert(product_images).values({
    id: image_id,
    tenant_id,
    sku_id: id,
    r2_key,
    hash,
    content_type: ctClean,
    bytes: buf.byteLength,
    created_at: now,
  });

  return c.json({ image_id, r2_key, bytes: buf.byteLength }, 201);
});
