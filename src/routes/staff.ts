/**
 * Mitarbeiter-Anmeldung (öffentlich, Tenant über `X-Tenant-Slug`) und
 * Mitarbeiter-Verwaltung (Tenant-Bereich, nur Inhaber).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { email } from "../auth/email";
import { addStaff, requestStaffCode, verifyStaffCode } from "../auth/staff";
import { rateLimit } from "../middleware/rate-limit";
import { ownerOnly } from "../middleware/tenant-auth";
import { getTenantBySlug } from "../lib/tenant-cache";

const identify = (c: import("hono").Context): string =>
  `staff/${c.req.header("X-Tenant-Slug") ?? "_no_tenant"}/${c.req.header("CF-Connecting-IP") ?? "_no_ip"}`;

async function tenantFromSlug(c: import("hono").Context<AppContext>): Promise<string> {
  const slug = c.req.header("X-Tenant-Slug");
  if (!slug) throw new CodedError("GH-INPUT-001", { reason: "missing X-Tenant-Slug" });
  const t = await getTenantBySlug(c.env, slug);
  if (!t || t.status !== "active") throw new CodedError("GH-TENANT-001");
  return t.id;
}

export const staffAuthRoutes = new Hono<AppContext>();
staffAuthRoutes.use("/code/request", rateLimit({ class: "magic_link_request", identify }));
staffAuthRoutes.use("/code/verify", rateLimit({ class: "auth_login", identify }));

const RequestSchema = z.object({ email: z.string().email().max(160) }).strict();
staffAuthRoutes.post("/code/request", async (c) => {
  const parsed = RequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const tenant_id = await tenantFromSlug(c);
  const mailer = email(c.env);
  if (!mailer) throw new CodedError("GH-EXT-003");
  const r = await requestStaffCode(c.env, tenant_id, parsed.data.email);
  if (r.staff_id && r.code) {
    await mailer.send({
      to: parsed.data.email,
      subject: "Dein Anmelde-Code für das Händler-Dashboard",
      text: `Dein Anmelde-Code: ${r.code}\n\nDieser Code ist 10 Minuten gültig. Hast du ihn nicht angefordert, ignoriere diese Mail.`,
    });
  }
  return c.json({ ok: true, ttl_sec: r.ttl_sec });
});

const VerifySchema = z.object({
  email: z.string().email().max(160),
  code: z.string().length(8).regex(/^[2-9A-HJ-NP-Z]+$/),
}).strict();
staffAuthRoutes.post("/code/verify", async (c) => {
  const parsed = VerifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const tenant_id = await tenantFromSlug(c);
  const tokens = await verifyStaffCode(c.env, tenant_id, parsed.data.email, parsed.data.code.toUpperCase());
  c.header("Cache-Control", "no-store");
  return c.json(tokens);
});

/** `/v1/staff` — wer im Dashboard arbeiten darf. Lesen dürfen alle, ändern nur Inhaber. */
export const staffRoutes = new Hono<AppContext>();

staffRoutes.get("/me", async (c) => {
  if (!c.var.staff_id) throw new CodedError("GH-AUTH-004");
  const row = await c.env.DB.prepare("SELECT id, email, role FROM staff_users WHERE id = ? AND tenant_id = ?")
    .bind(c.var.staff_id, c.var.tenant_id).first();
  return c.json(row);
});

staffRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, email, role, created_at, disabled_at FROM staff_users WHERE tenant_id = ? ORDER BY created_at")
    .bind(c.var.tenant_id).all();
  return c.json({ data: rows.results ?? [] });
});

const AddSchema = z.object({ email: z.string().email().max(160), role: z.enum(["owner", "staff"]).default("staff") }).strict();
staffRoutes.post("/", ownerOnly(), async (c) => {
  const parsed = AddSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  return c.json(await addStaff(c.env, c.var.tenant_id as string, parsed.data.email, parsed.data.role), 201);
});

staffRoutes.delete("/:id", ownerOnly(), async (c) => {
  const id = c.req.param("id");
  if (id === c.var.staff_id) throw new CodedError("GH-STAFF-002");
  const res = await c.env.DB.prepare("UPDATE staff_users SET disabled_at = ? WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL")
    .bind(new Date().toISOString(), id, c.var.tenant_id).run();
  if (!res.meta.changes) throw new CodedError("GH-TENANT-001");
  return c.body(null, 204);
});
