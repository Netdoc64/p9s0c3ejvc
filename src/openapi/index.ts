/**
 * Mount-Helpers: /openapi.json + /schemas/order.json
 */
import { Hono } from "hono";
import type { AppContext } from "../env";
import { OrderDocSchema } from "../schemas/order";
import { buildOpenApiDocument } from "./spec";
import { toJsonSchema } from "./json-schema";

export const docsRoutes = new Hono<AppContext>();

docsRoutes.get("/openapi.json", (c) => {
  const url = new URL(c.req.url);
  const localUrl = `${url.protocol}//${url.host}`;
  const doc = buildOpenApiDocument({
    worker_version: c.env.WORKER_VERSION,
    servers: [
      { url: "https://api.grosshandel.app", description: "Production" },
      { url: "https://staging.api.grosshandel.app", description: "Staging" },
      { url: localUrl, description: "Current host" },
    ],
  });
  return c.json(doc, 200, {
    "Cache-Control": "public, max-age=300",
  });
});

docsRoutes.get("/schemas/order.json", (c) => {
  const json = { title: "OrderDocument", ...toJsonSchema(OrderDocSchema) };
  return c.json(json, 200, {
    "Content-Type": "application/schema+json",
    "Cache-Control": "public, max-age=300",
  });
});

export { buildOpenApiDocument } from "./spec";
export { KNOWN_PATHS } from "./spec";
