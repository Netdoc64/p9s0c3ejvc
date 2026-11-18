import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { createMagicLink, verifyMagicLink } from "../auth/magic-link";
import { rotateRefresh, revokeRefresh } from "../auth/refresh";
import { issueTokenPair } from "../auth/token-issuance";
import { auth_authorization_codes } from "../db/schema/auth";
import { sha256Hex, randomSecret } from "../lib/crypto";
import { verifyPkce } from "../auth/pkce";
import { email } from "../auth/email";
import { rateLimit } from "../middleware/rate-limit";
import { getTenantBySlug } from "../lib/tenant-cache";

/**
 * Diese Routes sind tenant-public (kein Tenant-API-Key, kein HMAC). Tenant-Resolution
 * passiert über `X-Tenant-Slug` (oder Pfad-Param). Für v1 Header.
 */
export const authRoutes = new Hono<AppContext>();

// Rate-Limits: Magic-Link 3/min, Login 5/min, Token-Refresh 60/min (cross_cutting).
// Identifier: X-Tenant-Slug + CF-Connecting-IP (Tenant-ID ist hier noch nicht resolved).
const authRateLimitIdentify = (c: import("hono").Context): string => {
  const slug = c.req.header("X-Tenant-Slug") ?? "_no_tenant";
  const ip = c.req.header("CF-Connecting-IP") ?? "_no_ip";
  return `${slug}/${ip}`;
};
authRoutes.use("/magic-link/request", rateLimit({ class: "magic_link_request", identify: authRateLimitIdentify }));
authRoutes.use("/oauth/authorize", rateLimit({ class: "auth_login", identify: authRateLimitIdentify }));
authRoutes.use("/oauth/token", rateLimit({ class: "auth_token_refresh", identify: authRateLimitIdentify }));

async function resolveTenantId(c: import("hono").Context<AppContext>): Promise<string> {
  const slug = c.req.header("X-Tenant-Slug");
  if (!slug) throw new CodedError("GH-INPUT-001", { reason: "missing X-Tenant-Slug" });
  // KV-Cache (#A-018): 60s TTL, fail-open zu D1.
  const t = await getTenantBySlug(c.env, slug);
  if (!t || t.status !== "active") throw new CodedError("GH-TENANT-001");
  return t.id;
}

const MagicLinkRequestSchema = z.object({ email: z.string().email().max(160) }).strict();
authRoutes.post("/magic-link/request", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = MagicLinkRequestSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const tenant_id = await resolveTenantId(c);
  // Zustellweg VOR dem Kunden-Lookup prüfen: sonst unterschiede sich die
  // Antwort für bekannte und unbekannte Adressen (User-Enumeration).
  const mailer = email(c.env);
  if (!mailer) throw new CodedError("GH-EXT-003");
  const db = getDb(c.env.DB);
  const r = await createMagicLink(db, tenant_id, parsed.data.email);
  if (r.customer_id && r.code) {
    await mailer.send({
      to: parsed.data.email,
      subject: "Dein Login-Code",
      text: `Dein Login-Code: ${r.code}\n\nDieser Code ist 10 Minuten gültig.`,
    });
  }
  // Stets gleiche Antwort (User-Enumeration-Schutz).
  return c.json({ ok: true, ttl_sec: r.ttl_sec });
});

// Magic-Link-Code: exakt 8 Crockford-Base32-Chars (#V-010)
const MagicLinkVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(8).regex(/^[2-9A-HJ-NP-Z]+$/, "invalid magic-link code"),
}).strict();
authRoutes.post("/magic-link/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = MagicLinkVerifySchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const tenant_id = await resolveTenantId(c);
  const db = getDb(c.env.DB);
  const result = await verifyMagicLink(db, tenant_id, parsed.data.email, parsed.data.code);
  const tokens = await issueTokenPair(c.env, tenant_id, result.customer_id, result.scope, "magic-link");
  return c.json(tokens);
});

const OAuthAuthorizeSchema = z.object({
  client_id: z.string().min(1).max(80),
  redirect_uri: z.string().url().max(2048).optional(),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/, "code_challenge must be base64url"),
  code_challenge_method: z.literal("S256"),
  scope: z.string().max(500).default("customer_self"),
  state: z.string().max(500).optional(),
  email: z.string().email().max(160),
  magic_link_code: z.string().length(8).regex(/^[2-9A-HJ-NP-Z]+$/, "invalid magic-link code"),
}).strict();

/**
 * OAuth-Authorize mit inline Magic-Link-Auth. v1-Pragma:
 * Statt Browser-Redirect-UI führt der Client den Magic-Link-Flow vorher mit
 * `/magic-link/request` aus, ruft dann hier `authorize` mit (email, code)+PKCE auf
 * und erhält direkt einen authorization_code zurück (statt Redirect).
 */
authRoutes.post("/oauth/authorize", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = OAuthAuthorizeSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001", { issues: parsed.error.flatten() });
  const tenant_id = await resolveTenantId(c);
  const db = getDb(c.env.DB);

  const verified = await verifyMagicLink(db, tenant_id, parsed.data.email, parsed.data.magic_link_code);

  const code = `code_${randomSecret(32)}`;
  const code_hash = await sha256Hex(code);
  const now = new Date();
  await db.insert(auth_authorization_codes).values({
    code_hash,
    tenant_id,
    customer_id: verified.customer_id,
    client_id: parsed.data.client_id,
    redirect_uri: parsed.data.redirect_uri ?? null,
    code_challenge: parsed.data.code_challenge,
    code_challenge_method: parsed.data.code_challenge_method,
    scope: parsed.data.scope,
    expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
  });
  return c.json({ code, state: parsed.data.state, expires_in: 300 });
});

const OAuthTokenSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().startsWith("code_"),
    code_verifier: z.string().min(43).max(128),
    client_id: z.string().min(1).max(80),
    redirect_uri: z.string().url().optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(10),
  }),
]);

authRoutes.post("/oauth/token", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = OAuthTokenSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const tenant_id = await resolveTenantId(c);
  const db = getDb(c.env.DB);

  if (parsed.data.grant_type === "authorization_code") {
    const code_hash = await sha256Hex(parsed.data.code);
    const rows = await db.select().from(auth_authorization_codes).where(eq(auth_authorization_codes.code_hash, code_hash)).limit(1);
    const row = rows[0];
    if (!row || row.consumed_at || row.tenant_id !== tenant_id) throw new CodedError("GH-AUTH-006");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new CodedError("GH-AUTH-006");
    // Constant-time client_id check (#A-015) — Length-Equal + XOR-Diff.
    {
      const a = row.client_id;
      const b = parsed.data.client_id;
      if (a.length !== b.length) throw new CodedError("GH-AUTH-008");
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      if (diff !== 0) throw new CodedError("GH-AUTH-008");
    }

    if (row.code_challenge_method !== "S256") throw new CodedError("GH-AUTH-008");
    const ok = await verifyPkce(parsed.data.code_verifier, row.code_challenge, "S256");
    if (!ok) throw new CodedError("GH-AUTH-008");

    // Atomic Code-Consumption (#A-006): nur wenn consumed_at IS NULL ist.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upd = (await (db.update(auth_authorization_codes)
      .set({ consumed_at: new Date().toISOString() })
      .where(and(eq(auth_authorization_codes.code_hash, code_hash), isNull(auth_authorization_codes.consumed_at))) as any)) as { meta?: { changes?: number; rows_written?: number } } | undefined;
    const changed = upd?.meta?.changes ?? upd?.meta?.rows_written;
    if (typeof changed === "number" && changed === 0) {
      throw new CodedError("GH-AUTH-006");
    }
    const tokens = await issueTokenPair(c.env, tenant_id, row.customer_id, row.scope.split(" ").filter(Boolean), parsed.data.client_id);
    return c.json(tokens);
  }

  if (parsed.data.grant_type === "refresh_token") {
    const result = await rotateRefresh(db, parsed.data.refresh_token);
    if (result.tenant_id !== tenant_id) throw new CodedError("GH-TENANT-001");
    // skipRefresh (#A-008): Refresh-Token kommt aus rotateRefresh, kein orphan erzeugen.
    const access = await issueTokenPair(c.env, tenant_id, result.customer_id, result.scope, undefined, { skipRefresh: true });
    return c.json({
      access_token: access.access_token,
      refresh_token: result.new_refresh.plain,
      token_type: "Bearer" as const,
      expires_in: access.expires_in,
      scope: access.scope,
    });
  }

  throw new CodedError("GH-INPUT-001");
});

const RevokeSchema = z.object({ token: z.string(), token_type_hint: z.enum(["refresh_token"]).optional() });
authRoutes.post("/oauth/revoke", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = RevokeSchema.safeParse(body);
  if (!parsed.success) throw new CodedError("GH-INPUT-001");
  const db = getDb(c.env.DB);
  await revokeRefresh(db, parsed.data.token);
  return c.body(null, 204);
});
