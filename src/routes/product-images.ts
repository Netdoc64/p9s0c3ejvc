/**
 * Öffentliche Auslieferung von Produktbildern: `GET /v1/public/product-images/{id}`.
 *
 * Bis 2026-11-17 ließen sich Bilder über `POST /v1/products/{id}/images` nur
 * hochladen — ausgeliefert wurden sie nirgends, und die App hatte keine URL.
 *
 * Öffentlich, weil Produktfotos nicht geheim sind und App-Bildlader ohne
 * Auth-Header auskommen sollen. Die `id` ist eine zufällige ULID (nicht
 * aufzählbar); das Objekt in R2 ist nach Inhalts-Hash benannt und ändert sich
 * nie → `immutable`. Ein Bild eines gelöschten Produkts wird nicht mehr
 * ausgeliefert.
 */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { product_images, products } from "../db/schema/products";

export const productImagesRoutes = new Hono<AppContext>();

productImagesRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_]{10,64}$/.test(id)) throw new CodedError("GH-PROD-001");
  const db = getDb(c.env.DB);
  const row = (await db
    .select({ r2_key: product_images.r2_key, content_type: product_images.content_type, hash: product_images.hash })
    .from(product_images)
    .innerJoin(products, and(eq(products.id, product_images.sku_id), eq(products.tenant_id, product_images.tenant_id)))
    .where(and(eq(product_images.id, id), isNull(products.deleted_at), eq(products.status, "active")))
    .limit(1))[0];
  if (!row) throw new CodedError("GH-PROD-001");
  const obj = await c.env.ASSETS.get(row.r2_key);
  if (!obj) throw new CodedError("GH-PROD-001");
  return new Response(obj.body as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${row.hash}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** URL-Pfad zu einem Bild — relativ zur API-Basis. */
export function productImagePath(image_id: string): string {
  return `/v1/public/product-images/${image_id}`;
}
