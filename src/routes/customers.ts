import { Hono } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import * as customersRepo from "../repos/customers";
import { CustomerCreateSchema, CustomerPatchSchema } from "../schemas/customer";
import { newId } from "../lib/ids";
import { vies } from "../services/vies";
import { parseCursor, parseLimit, signCursor } from "../lib/http";

export const customersRoutes = new Hono<AppContext>();

function tenantId(c: import("hono").Context<AppContext>): string {
  const t = c.var.tenant_id;
  if (!t) throw new CodedError("GH-AUTH-001");
  return t;
}

function sanitize<T extends { metadata?: string; addresses?: string }>(c: T): T & { metadata?: unknown; addresses?: unknown } {
  return {
    ...c,
    metadata: c.metadata ? JSON.parse(c.metadata) : {},
    addresses: c.addresses ? JSON.parse(c.addresses) : {},
  };
}

customersRoutes.post("/", async (c) => {
  const tenant_id = tenantId(c);
  const body = await c.req.json();
  const parsed = CustomerCreateSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);

  if (parsed.data.vat_id) {
    const existing = await customersRepo.findByVatId(db, tenant_id, parsed.data.vat_id);
    if (existing) throw new CodedError("GH-CUST-002", { existing_customer_id: existing.id });
  }

  let vat_status: "valid" | "invalid" | "unknown" | "not_required" = "not_required";
  let vies_checked_at: string | null = null;
  if (parsed.data.vat_id) {
    const result = await vies().validate(c.env, parsed.data.vat_id);
    vat_status = result.status;
    vies_checked_at = result.checked_at;
  }

  const now = new Date().toISOString();
  const id = newId("customer");
  const inserted = await customersRepo.create(db, {
    id,
    tenant_id,
    external_id: parsed.data.external_id ?? null,
    name: parsed.data.name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone ?? null,
    country: parsed.data.country,
    b2b_b2c: parsed.data.b2b_b2c,
    vat_id: parsed.data.vat_id ?? null,
    vat_status,
    vies_checked_at,
    language: parsed.data.language ?? null,
    credit_limit_cents: parsed.data.credit_limit_cents ?? null,
    blocked: 0,
    addresses: JSON.stringify(parsed.data.addresses),
    metadata: JSON.stringify(parsed.data.metadata ?? {}),
    created_at: now,
    updated_at: now,
  });

  return c.json(sanitize(inserted), 201);
});

customersRoutes.get("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const row = await customersRepo.requireById(db, tenant_id, id);
  return c.json(sanitize(row));
});

customersRoutes.patch("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const body = await c.req.json();
  const parsed = CustomerPatchSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });

  const db = getDb(c.env.DB);
  const before = await customersRepo.requireById(db, tenant_id, id);

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (k === "addresses" || k === "metadata") patch[k] = JSON.stringify(v);
    else patch[k] = v;
  }

  if (parsed.data.vat_id && parsed.data.vat_id !== before.vat_id) {
    const result = await vies().validate(c.env, parsed.data.vat_id, { skipCache: true });
    patch.vat_status = result.status;
    patch.vies_checked_at = result.checked_at;
  }

  const updated = await customersRepo.update(db, tenant_id, id, patch);
  return c.json(sanitize(updated));
});

customersRoutes.get("/", async (c) => {
  const tenant_id = tenantId(c);
  const db = getDb(c.env.DB);
  const limit = parseLimit(c.req.query("limit"));
  const cursor = await parseCursor(c.env, c.req.query("cursor"));
  const rows = await customersRepo.list(db, tenant_id, { cursor, limit });
  const last = rows[rows.length - 1];
  const next = rows.length === limit && last ? await signCursor(c.env, { created_at: last.created_at, id: last.id }) : null;

  return c.json({
    items: rows.map(sanitize),
    next_cursor: next,
  });
});

customersRoutes.delete("/:id", async (c) => {
  const tenant_id = tenantId(c);
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  await customersRepo.requireById(db, tenant_id, id);
  await customersRepo.softDelete(db, tenant_id, id);
  return c.body(null, 204);
});
