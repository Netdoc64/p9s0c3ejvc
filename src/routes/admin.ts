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
