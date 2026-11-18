import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { devices } from "../db/schema/devices";
import { newId } from "../lib/ids";

export const devicesRoutes = new Hono<AppContext>();

// Per-Platform push_token Format (#V-008):
// - iOS APNs: 64-hex (32 byte) oder Base64-encoded form
// - Android FCM v1: variable length, alphanumeric incl. : - _
// - Web Push: VAPID-JWT-style or PushManager subscription identifier
// Strict-Pattern erlaubt nur sichere Charaktere; verhindert unkontrollierte Strings in Logs/IDs.
const RegisterSchema = z.object({
  platform: z.enum(["ios", "android", "web"]),
  push_token: z.string().min(20).max(400).regex(/^[A-Za-z0-9._:\-]+$/, "invalid push_token characters"),
  app_version: z.string().max(40).regex(/^[A-Za-z0-9.\-+]+$/).optional(),
  language: z.string().max(10).regex(/^[a-zA-Z\-_]+$/).optional(),
  timezone: z.string().max(60).regex(/^[A-Za-z0-9_+\-/]+$/).optional(),
}).strict();

devicesRoutes.post("/", async (c) => {
  // Customer-Auth pflicht
  const customer_id = c.var.customer_id;
  const tenant_id = c.var.tenant_id;
  if (!customer_id || !tenant_id) throw new CodedError("GH-AUTH-001");
  const body = await c.req.json();
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const db = getDb(c.env.DB);
  const id = newId("device");
  const now = new Date().toISOString();
  // Existing token nur tenant-scoped aktualisieren (#T-001).
  // Wenn der Push-Token bereits in einem anderen Tenant existiert → reject:
  // OS-Push-Token können theoretisch zwischen Apps geteilt werden, aber im Multi-Tenant-
  // Kontext darf ein Customer von Tenant B nicht den Token-Slot von Tenant A übernehmen.
  const existing = (await db.select().from(devices).where(and(eq(devices.push_token, parsed.data.push_token), eq(devices.tenant_id, tenant_id))).limit(1))[0];
  const otherTenant = (await db.select({ id: devices.id }).from(devices).where(eq(devices.push_token, parsed.data.push_token)).limit(1))[0];
  if (existing) {
    await db.update(devices).set({ customer_id, platform: parsed.data.platform, app_version: parsed.data.app_version ?? null, language: parsed.data.language ?? null, timezone: parsed.data.timezone ?? null, active: 1, last_seen_at: now }).where(and(eq(devices.id, existing.id), eq(devices.tenant_id, tenant_id)));
    return c.json({ id: existing.id, status: "updated" });
  }
  if (otherTenant) {
    // Token ist in fremdem Tenant aktiv — nicht hijacken
    throw new CodedError("GH-INPUT-001", { reason: "push_token already registered in another tenant" });
  }
  await db.insert(devices).values({
    id, tenant_id, customer_id,
    platform: parsed.data.platform, push_token: parsed.data.push_token,
    app_version: parsed.data.app_version ?? null,
    language: parsed.data.language ?? null,
    timezone: parsed.data.timezone ?? null,
    active: 1, last_seen_at: now, created_at: now,
  });
  return c.json({ id, status: "registered" }, 201);
});

devicesRoutes.delete("/:id", async (c) => {
  const customer_id = c.var.customer_id;
  const tenant_id = c.var.tenant_id;
  if (!customer_id || !tenant_id) throw new CodedError("GH-AUTH-001");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  // tenant_id-Filter (#T-002 Defense-in-Depth)
  await db.update(devices).set({ active: 0 }).where(and(eq(devices.id, id), eq(devices.customer_id, customer_id), eq(devices.tenant_id, tenant_id)));
  return c.body(null, 204);
});
