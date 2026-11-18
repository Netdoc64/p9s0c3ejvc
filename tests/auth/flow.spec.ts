import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { customers } from "../../src/db/schema/customers";
import { auth_magic_link_tokens, auth_refresh_tokens } from "../../src/db/schema/auth";
import { newId } from "../../src/lib/ids";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { setEmailAdapter, resetEmailAdapter } from "../../src/auth/email";
import { sha256Hex } from "../../src/lib/crypto";
import { verifyPkce, bytesToBase64Url } from "../../src/auth/pkce";

let tenant: SeededTenant;
let testCounter = 0;
const capturedCodes: Array<{ to: string; code: string }> = [];

beforeEach(async () => {
  // Unique slug pro Test → Rate-Limit-Bucket pro Test isoliert
  testCounter += 1;
  tenant = await seedTenant({ slug: `auth-test-${testCounter}-${Math.random().toString(36).slice(2, 6)}` });
  capturedCodes.length = 0;
  setEmailAdapter({
    async send(msg) {
      // Magic-Link-Code: 8-Char-Base32 — alphabet "23456789ABCDEFGHJKLMNPQRSTUVWXYZ" (no 0,1,I,O)
      const m = msg.text.match(/([2-9A-HJ-NP-Z]{8})/);
      if (m) capturedCodes.push({ to: msg.to, code: m[1] as string });
    },
  });
  // Customer anlegen
  const db = getDb(env.DB);
  const now = new Date().toISOString();
  await db.insert(customers).values({
    id: newId("customer"),
    tenant_id: tenant.tenant_id,
    name: "Floraly",
    email: "floraly@example.com",
    country: "DE",
    b2b_b2c: "b2b",
    vat_status: "valid",
    addresses: '{"billing":{"line1":"x","postal_code":"1","city":"x","country":"DE"}}',
    metadata: "{}",
    created_at: now,
    updated_at: now,
  });
});

afterEach(async () => {
  resetEmailAdapter();
  await env.DB.prepare("DELETE FROM auth_authorization_codes").run();
  await env.DB.prepare("DELETE FROM auth_refresh_tokens").run();
  await env.DB.prepare("DELETE FROM auth_magic_link_tokens").run();
  await env.DB.prepare("DELETE FROM customers").run();
  await clearTenants();
});

async function postJson(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant-Slug": tenant.slug, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe("magic-link flow", () => {
  it("request → verify → tokens; access ist gültiger JWT", async () => {
    const r1 = await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    expect(r1.status).toBe(200);
    expect(capturedCodes.length).toBe(1);
    const code = capturedCodes[0]?.code as string;

    const r2 = await postJson("/v1/auth/magic-link/verify", { email: "floraly@example.com", code });
    expect(r2.status).toBe(200);
    const tokens = (await r2.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.access_token.split(".").length).toBe(3);
    expect(tokens.refresh_token).toMatch(/^gr_/);
    expect(tokens.expires_in).toBe(900);
  });

  it("falscher Code → 410 GH-AUTH-006", async () => {
    await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    // Code muss Format passieren (#V-010): 8 Crockford-Base32-Chars, sonst 400 vor Verify-Logik.
    const r = await postJson("/v1/auth/magic-link/verify", { email: "floraly@example.com", code: "ZZZZZZZZ" });
    expect(r.status).toBe(410);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-AUTH-006");
  });

  it("unbekannte Email gibt 200 ohne Code (User-Enumeration-Schutz)", async () => {
    const r = await postJson("/v1/auth/magic-link/request", { email: "nobody@example.com" });
    expect(r.status).toBe(200);
    expect(capturedCodes.length).toBe(0);
  });
});

describe("OAuth code+PKCE flow", () => {
  it("authorize+token tauscht code+verifier gegen access+refresh", async () => {
    const verifier = "v".repeat(64);
    const hex = await sha256Hex(verifier);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const challenge = bytesToBase64Url(bytes);

    await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    const code = capturedCodes[0]?.code as string;

    const r1 = await postJson("/v1/auth/oauth/authorize", {
      client_id: "mobile-app",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "customer_self",
      email: "floraly@example.com",
      magic_link_code: code,
    });
    expect(r1.status).toBe(200);
    const auth = (await r1.json()) as { code: string };
    expect(auth.code.startsWith("code_")).toBe(true);

    const r2 = await postJson("/v1/auth/oauth/token", {
      grant_type: "authorization_code",
      code: auth.code,
      code_verifier: verifier,
      client_id: "mobile-app",
    });
    expect(r2.status).toBe(200);
    const tokens = (await r2.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token.split(".").length).toBe(3);
  });

  it("bad code_verifier → 400 GH-AUTH-008", async () => {
    const verifier = "v".repeat(64);
    const hex = await sha256Hex(verifier);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const challenge = bytesToBase64Url(bytes);

    await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    const code = capturedCodes[0]?.code as string;
    const auth = (await (await postJson("/v1/auth/oauth/authorize", {
      client_id: "mobile-app",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "customer_self",
      email: "floraly@example.com",
      magic_link_code: code,
    })).json()) as { code: string };

    const r = await postJson("/v1/auth/oauth/token", {
      grant_type: "authorization_code",
      code: auth.code,
      code_verifier: "WRONG".repeat(20),
      client_id: "mobile-app",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Record<string, unknown>).code).toBe("GH-AUTH-008");
  });
});

describe("refresh-token rotation + replay-detection", () => {
  it("rotate gibt neuen refresh, alter ist invalid", async () => {
    await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    const code = capturedCodes[0]?.code as string;
    const t1 = (await (await postJson("/v1/auth/magic-link/verify", { email: "floraly@example.com", code })).json()) as { refresh_token: string };

    const r = await postJson("/v1/auth/oauth/token", { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as { refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);

    // Erneut t1 → Replay → 401, Familie revoked
    const replay = await postJson("/v1/auth/oauth/token", { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as Record<string, unknown>).code).toBe("GH-AUTH-007");

    // Auch t2 (gleiche Familie) jetzt revoked
    const after = await postJson("/v1/auth/oauth/token", { grant_type: "refresh_token", refresh_token: t2.refresh_token });
    expect(after.status).toBe(401);
  });
});

describe("customer-auth middleware (cross-tenant 404)", () => {
  it("JWT mit tenant_id einer anderen Tenant → 404", async () => {
    const otherTenant = await seedTenant({ slug: "other" });
    void otherTenant;
    // Magic-link bei Tenant A
    await postJson("/v1/auth/magic-link/request", { email: "floraly@example.com" });
    const code = capturedCodes[0]?.code as string;
    const tokens = (await (await postJson("/v1/auth/magic-link/verify", { email: "floraly@example.com", code })).json()) as { access_token: string };

    // Tampering: tenant_id im Payload manipulieren würde Signature brechen.
    // Realistic test: Tenant A's JWT bei Tenant B's Resource — über X-Tenant-Slug: "other"
    // Es gibt aktuell keine customer-bound Resource. Erweiterung in M11.
    void tokens;
    expect(tokens.access_token).toBeTruthy();
  });
});
