/**
 * Betriebs-Endpunkte, die nur der Business Manager ruft — nie ein Tenant,
 * nie ein Kunde. Geschützt mit `ADMIN_API_KEY` (Worker-Secret, vom Business
 * Manager gewürfelt und verteilt) im Header `X-Admin-Key`.
 *
 * Fehlt das Secret am Worker, ist der Endpunkt AUS (503) — nicht offen.
 */
import { Hono } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { sha256Hex, constantTimeEqualHex } from "../lib/crypto";
import { issueTenantKey } from "../services/api-key-issuance";
import { addStaff } from "../auth/staff";
import { moduleDef } from "../modules/registry";
import { evaluate, fingerprint } from "../ops/watch";

export const MIN_ADMIN_KEY_LENGTH = 32;

export const adminRoutes = new Hono<AppContext>();

adminRoutes.use("*", async (c, next) => {
  const expected = c.env.ADMIN_API_KEY;
  if (!expected || expected.length < MIN_ADMIN_KEY_LENGTH) throw new CodedError("GH-ADMIN-002");
  const given = c.req.header("X-Admin-Key") ?? "";
  // Vergleich über die Prüfsummen: gleich lang, also ohne Längen-Leck.
  const ok = constantTimeEqualHex(await sha256Hex(given), await sha256Hex(expected));
  if (!ok) throw new CodedError("GH-ADMIN-001");
  await next();
});

/**
 * Selbstauskunft für den Vorflug des Business Managers: welche Tenants es hier
 * gibt. `id` ist der Slug — derselbe, der im Pfad der Ausgabe-Route steht und
 * gegen den der Manager sein Ziel ausweist. Nur Bezeichner und Zustand, keine
 * Kundendaten, kein Geheimnis.
 */
adminRoutes.get("/tenants", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT slug, name, status FROM tenants WHERE deleted_at IS NULL ORDER BY slug LIMIT 2000",
  ).all<{ slug: string; name: string; status: string }>();
  c.header("Cache-Control", "no-store");
  return c.json({ tenants: (rows.results ?? []).map((r) => ({ id: r.slug, name: r.name, status: r.status })) });
});

/**
 * Vertrag „remote-mint“ des Business Managers:
 *   POST, Header `Idempotency-Key`, Body `{ env_var, idempotency_key }`.
 *   200 → `{ value, fingerprint }` (fingerprint = sha256(value) hex, 12 Zeichen)
 *   409 → zu diesem Idempotency-Key wurde schon ausgegeben; KEIN Wert.
 */
adminRoutes.post("/tenants/:slug/api-keys", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new CodedError("GH-INPUT-001", { reason: "slug" });
  const header = c.req.header("Idempotency-Key")?.trim() ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { idempotency_key?: unknown };
  const fromBody = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const key = header || fromBody;
  if (!key || key.length > 200) throw new CodedError("GH-INPUT-001", { reason: "Idempotency-Key fehlt" });
  if (header && fromBody && header !== fromBody) throw new CodedError("GH-INPUT-001", { reason: "Idempotency-Key widersprüchlich" });

  const issued = await issueTenantKey(c.env, slug, key);
  c.header("Cache-Control", "no-store");
  return c.json(issued);
});

/**
 * Ersten Inhaber eines Tenants anlegen (danach verwaltet er seine Leute selbst
 * über /v1/staff). Kein Geheimnis im Spiel: angemeldet wird per Mail-Code.
 */
adminRoutes.post("/tenants/:slug/staff", async (c) => {
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
  if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email) || body.email.length > 160) {
    throw new CodedError("GH-INPUT-001", { reason: "email" });
  }
  const role = body.role === "staff" ? "staff" : "owner";
  const tenant = await c.env.DB.prepare("SELECT id FROM tenants WHERE slug = ? AND deleted_at IS NULL AND status = 'active'").bind(slug).first<{ id: string }>();
  if (!tenant) throw new CodedError("GH-TENANT-001");
  return c.json(await addStaff(c.env, tenant.id, body.email, role), 201);
});

/** Betreiber: Modul für einen Tenant freischalten oder sperren (`available`). */
adminRoutes.put("/tenants/:slug/modules/:id", async (c) => {
  const def = moduleDef(c.req.param("id"));
  if (!def) throw new CodedError("GH-MODULE-001");
  const body = (await c.req.json().catch(() => ({}))) as { available?: unknown };
  if (typeof body.available !== "boolean") throw new CodedError("GH-INPUT-001", { reason: "available" });
  const tenant = await c.env.DB.prepare("SELECT id FROM tenants WHERE slug = ? AND deleted_at IS NULL").bind(c.req.param("slug")).first<{ id: string }>();
  if (!tenant) throw new CodedError("GH-TENANT-001");
  const now = new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO tenant_modules (tenant_id, module_id, available, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id, module_id) DO UPDATE SET available = excluded.available, enabled = CASE WHEN excluded.available = 0 THEN 0 ELSE enabled END, updated_at = excluded.updated_at`)
    .bind(tenant.id, def.id, body.available ? 1 : 0, now).run();
  return c.json({ module: def.id, available: body.available });
});

/** Betreiber: aktuelle Alarmlage (dieselbe Bewertung wie der Wächter, ohne Mail). */
adminRoutes.get("/ops/alarms", async (c) => {
  const firing = await evaluate(c.env);
  c.header("Cache-Control", "no-store");
  return c.json({ firing, fingerprint: await fingerprint(firing), checked_at: new Date().toISOString() });
});
