/**
 * `/v1/sourcing` — Quellenmix im Händler-Dashboard.
 * Lesen dürfen alle Mitarbeiter, ändern nur Inhaber (und API-Keys).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { newId } from "../lib/ids";
import { ownerOnly } from "../middleware/tenant-auth";
import { getRules, recompute } from "../sourcing/engine";
import { listOffers, offerKey } from "../sourcing/offers";

export const sourcingRoutes = new Hono<AppContext>();

async function tenantCurrency(c: import("hono").Context<AppContext>): Promise<string> {
  const t = await c.env.DB.prepare("SELECT currency FROM tenants WHERE id = ?").bind(c.var.tenant_id).first<{ currency: string }>();
  if (!t) throw new CodedError("GH-TENANT-001");
  return t.currency;
}

sourcingRoutes.get("/offers", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const source = c.req.query("source");
  const after = Number(c.req.query("after") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new CodedError("GH-INPUT-001", { field: "after/limit" });
  let all = await listOffers(c.env, c.var.tenant_id as string, await tenantCurrency(c));
  if (q) all = all.filter((o) => o.name.toLowerCase().includes(q) || o.sku.toLowerCase().includes(q));
  if (source) all = all.filter((o) => o.provider === source || `${o.provider}:${o.connection}` === source);
  const items = all.slice(after, after + limit);
  return c.json({ items, next_after: after + limit < all.length ? String(after + limit) : null, total: all.length });
});

const RulesSchema = z.object({
  strategy: z.enum(["cheapest", "priority", "fastest"]),
  priority: z.array(z.string().min(1).max(130)).max(20).default([]),
  markup_pct: z.number().min(0).max(1000),
  min_margin_cents: z.number().int().min(0).max(1_000_000).default(0),
  round_to_cents: z.number().int().min(1).max(10_000).default(1),
}).strict();

sourcingRoutes.get("/rules", async (c) => c.json(await getRules(c.env, c.var.tenant_id as string)));

sourcingRoutes.put("/rules", ownerOnly(), async (c) => {
  const parsed = RulesSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const r = parsed.data;
  await c.env.DB.prepare(`INSERT INTO sourcing_rules (tenant_id, strategy, priority, markup_pct, min_margin_cents, round_to_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id) DO UPDATE SET strategy = excluded.strategy, priority = excluded.priority, markup_pct = excluded.markup_pct,
      min_margin_cents = excluded.min_margin_cents, round_to_cents = excluded.round_to_cents, updated_at = excluded.updated_at`)
    .bind(c.var.tenant_id, r.strategy, JSON.stringify(r.priority), r.markup_pct, r.min_margin_cents, r.round_to_cents, new Date().toISOString()).run();
  const res = await recompute(c.env, c.var.tenant_id as string);
  return c.json({ rules: r, recompute: res });
});

const SourceRef = z.object({
  provider: z.string().min(1).max(40),
  connection: z.string().min(1).max(130),
  source_ref: z.string().min(1).max(130),
  pack_factor: z.number().int().min(1).max(100_000).default(1),
}).strict();

async function requireProduct(c: import("hono").Context<AppContext>, id: string) {
  const p = await c.env.DB.prepare("SELECT id FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL").bind(id, c.var.tenant_id).first();
  if (!p) throw new CodedError("GH-PROD-001");
}

sourcingRoutes.get("/products/:id/sources", async (c) => {
  await requireProduct(c, c.req.param("id"));
  const rows = await c.env.DB.prepare("SELECT provider, connection, source_ref, pack_factor FROM product_sources WHERE tenant_id = ? AND sku_id = ? ORDER BY provider, connection, source_ref")
    .bind(c.var.tenant_id, c.req.param("id")).all();
  const state = await c.env.DB.prepare("SELECT * FROM product_sourcing_state WHERE tenant_id = ? AND sku_id = ?").bind(c.var.tenant_id, c.req.param("id")).first();
  return c.json({ sources: rows.results ?? [], state: state ?? null });
});

/** Quellen eines Artikels ERSETZEN (leere Liste = keine Quelle mehr). */
sourcingRoutes.put("/products/:id/sources", ownerOnly(), async (c) => {
  const id = c.req.param("id");
  await requireProduct(c, id);
  const parsed = z.array(SourceRef).max(20).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM product_sources WHERE tenant_id = ? AND sku_id = ?").bind(c.var.tenant_id, id),
    ...parsed.data.map((s) => c.env.DB.prepare("INSERT INTO product_sources (tenant_id, sku_id, provider, connection, source_ref, pack_factor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(c.var.tenant_id, id, s.provider, s.connection, s.source_ref, s.pack_factor, now)),
  ]);
  const res = await recompute(c.env, c.var.tenant_id as string);
  return c.json({ sources: parsed.data, recompute: res });
});

const ImportSchema = z.object({
  items: z.array(z.object({ provider: z.string(), connection: z.string(), source_ref: z.string() }).strict()).min(1).max(200),
  tax_class: z.enum(["standard", "reduced", "zero"]).default("reduced"),
}).strict();

/** Angebote als Verkaufsartikel übernehmen: Artikel anlegen (oder vorhandenen per SKU nutzen), Quelle verknüpfen, Preis rechnen. */
sourcingRoutes.post("/import", ownerOnly(), async (c) => {
  const parsed = ImportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const tenantId = c.var.tenant_id as string;
  const offers = new Map((await listOffers(c.env, tenantId, await tenantCurrency(c))).map((o) => [offerKey(o), o]));
  const now = new Date().toISOString();
  const created: string[] = [];
  const linked: string[] = [];
  const missing: string[] = [];
  for (const it of parsed.data.items) {
    const o = offers.get(offerKey(it));
    if (!o) { missing.push(offerKey(it)); continue; }
    const skuCode = `${o.provider === "floriday" ? "FD" : "LF"}-${o.sku}`.slice(0, 64);
    let product = await c.env.DB.prepare("SELECT id FROM products WHERE tenant_id = ? AND sku_code = ? AND deleted_at IS NULL").bind(tenantId, skuCode).first<{ id: string }>();
    if (!product) {
      const id = newId("product");
      await c.env.DB.prepare(`INSERT INTO products (id, tenant_id, sku_code, name, tax_class, is_perishable, min_order_qty, packaging_units, attributes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, '[]', ?, 'active', ?, ?)`)
        .bind(id, tenantId, skuCode, o.name, parsed.data.tax_class, Math.max(1, o.minimum_quantity), JSON.stringify({ source_unit: o.unit }), now, now).run();
      product = { id };
      created.push(id);
    }
    await c.env.DB.prepare("INSERT INTO product_sources (tenant_id, sku_id, provider, connection, source_ref, pack_factor, created_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING")
      .bind(tenantId, product.id, o.provider, o.connection, o.source_ref, now).run();
    linked.push(product.id);
  }
  const res = await recompute(c.env, tenantId);
  return c.json({ created, linked, missing, recompute: res }, 201);
});

sourcingRoutes.post("/recompute", ownerOnly(), async (c) => c.json(await recompute(c.env, c.var.tenant_id as string)));

sourcingRoutes.get("/state", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT s.*, p.name, p.sku_code FROM product_sourcing_state s JOIN products p ON p.id = s.sku_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? ORDER BY p.name LIMIT 500`).bind(c.var.tenant_id).all();
  return c.json({ items: rows.results ?? [] });
});
