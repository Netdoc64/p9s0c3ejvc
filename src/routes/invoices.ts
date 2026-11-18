import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppContext, Env } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { invoices } from "../db/schema/invoices";
import { hmacSha256Hex } from "../lib/crypto";
import { getTenantById } from "../lib/tenant-cache";
import { z } from "zod";

export const invoicesRoutes = new Hono<AppContext>();

/**
 * Signed-URL für Invoice-Download (#P-005).
 *
 * **Secret-Quelle (Copilot-Review-Fix):** Tenant.customer_jwt_secret. Der Secret ist
 * persistent in D1 und überlebt Deploys — vorher war der Secret deploy-bound
 * (`WORKER_VERSION:GIT_COMMIT`), wodurch jeder Deploy alle ausgegebenen 7-90-Tage-
 * Links invalidiert hätte.
 *
 * **Doppel-Reader bei Rotation:** verifyInvoiceToken probiert current + previous
 * JWT-Secret durch — analog zu #A-005. Damit überlebt der Token auch eine
 * Tenant-JWT-Secret-Rotation während der 7d-Karenz.
 *
 * Tenant-scoped: tenant_id ist Teil der Signatur. Kein Cross-Tenant-Replay.
 */
const SIGN_TTL_DEFAULT_DAYS = 7;
const SIGN_TTL_MAX_DAYS = 90;

async function signWith(secret: string, tenant_id: string, invoice_id: string, exp: number): Promise<string> {
  const payload = `invoice:${tenant_id}.${invoice_id}.${exp}`;
  const sig = (await hmacSha256Hex(secret, payload)).slice(0, 24);
  return `${exp}.${sig}`;
}

async function signInvoiceToken(env: Env, tenant_id: string, invoice_id: string, exp: number): Promise<string> {
  const tenant = await getTenantById(env, tenant_id);
  if (!tenant) throw new CodedError("GH-TENANT-001");
  return signWith(tenant.customer_jwt_secret, tenant_id, invoice_id, exp);
}

async function verifyInvoiceToken(env: Env, tenant_id: string, invoice_id: string, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expStr] = parts as [string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const tenant = await getTenantById(env, tenant_id);
  if (!tenant) return false;

  // Doppel-Reader: current + previous JWT-Secret während 7d-Karenz akzeptieren.
  const candidates: string[] = [tenant.customer_jwt_secret];
  if (tenant.customer_jwt_secret_previous && tenant.customer_jwt_secret_previous_until && tenant.customer_jwt_secret_previous_until > new Date().toISOString()) {
    candidates.push(tenant.customer_jwt_secret_previous);
  }
  for (const sec of candidates) {
    const expected = await signWith(sec, tenant_id, invoice_id, exp);
    if (constantTimeEqual(expected, token)) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Tenant-API: erzeugt einen signed Download-Token für einen Invoice. (#P-005)
 *
 * Anschließend kann jeder mit dem Token (z.B. Customer ohne API-Key) das PDF
 * unter /v1/invoices/:id/download?token=... abrufen.
 */
const SignSchema = z.object({ ttl_days: z.number().int().positive().max(SIGN_TTL_MAX_DAYS).optional() }).strict();

invoicesRoutes.post("/:id/sign", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = SignSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const ttl_days = parsed.data.ttl_days ?? SIGN_TTL_DEFAULT_DAYS;

  const db = getDb(c.env.DB);
  const row = (await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.tenant_id, tenant_id))).limit(1))[0];
  if (!row) throw new CodedError("GH-ORDER-001");

  const exp = Math.floor(Date.now() / 1000) + ttl_days * 86_400;
  const token = await signInvoiceToken(c.env, tenant_id, id, exp);
  return c.json({
    invoice_id: id,
    token,
    expires_at: new Date(exp * 1000).toISOString(),
    download_url: `/v1/public/invoices/${id}/download?token=${encodeURIComponent(token)}&t=${encodeURIComponent(tenant_id)}`,
  });
});

invoicesRoutes.get("/:id", async (c) => {
  const tenant_id = c.var.tenant_id;
  if (!tenant_id) throw new CodedError("GH-AUTH-001");
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const row = (await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.tenant_id, tenant_id))).limit(1))[0];
  if (!row) throw new CodedError("GH-ORDER-001");
  // v1: Direct R2 fetch (signed-URL-Strategy ist Plan-Revision-Kandidat).
  if (!row.pdf_r2_key) throw new CodedError("GH-PDF-001", { reason: "pdf_not_generated" });
  const obj = await c.env.ASSETS.get(row.pdf_r2_key);
  if (!obj) throw new CodedError("GH-PDF-001", { reason: "pdf_missing_in_r2" });
  return new Response(obj.body as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${row.invoice_number}.pdf"`,
      "X-Invoice-Hash": row.pdf_hash ?? "",
    },
  });
});

/**
 * Public-Download-Route ohne Auth (#P-005).
 * Wird in src/index.ts unter /v1/public/invoices gemountet.
 */
export const publicInvoicesRoutes = new Hono<AppContext>();

publicInvoicesRoutes.get("/:id/download", async (c) => {
  const id = c.req.param("id");
  const token = c.req.query("token");
  const tenant_id = c.req.query("t");
  if (!token || !tenant_id) throw new CodedError("GH-AUTH-001");
  const ok = await verifyInvoiceToken(c.env, tenant_id, id, token);
  if (!ok) throw new CodedError("GH-AUTH-001", { reason: "invalid_or_expired_token" });

  const db = getDb(c.env.DB);
  const row = (await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.tenant_id, tenant_id))).limit(1))[0];
  if (!row || !row.pdf_r2_key) throw new CodedError("GH-ORDER-001");
  const obj = await c.env.ASSETS.get(row.pdf_r2_key);
  if (!obj) throw new CodedError("GH-PDF-001", { reason: "pdf_missing_in_r2" });
  return new Response(obj.body as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${row.invoice_number}.pdf"`,
      "X-Invoice-Hash": row.pdf_hash ?? "",
    },
  });
});
