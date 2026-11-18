/**
 * Kunden-Login wie die App ihn macht — gegen einen laufenden Worker:
 *   Login-Code (aus der Mail) → /oauth/authorize (PKCE S256) → /oauth/token
 *   → Kunden-API mit dem Access-Token → Refresh (Rotation) → altes
 *   Refresh-Token ist danach ungültig.
 *
 * Den Code fordert vorher `/v1/auth/magic-link/request` an; er kommt per Mail.
 *
 * Erfordert:
 *   GROSSHANDEL_BASE_URL   Worker-URL
 *   GROSSHANDEL_TENANT     Tenant-Slug (z. B. pilot)
 *   LOGIN_EMAIL            Adresse des Kunden
 *   LOGIN_CODE             8-stelliger Code aus der Mail
 * Gibt am Ende NUR aus, ob es geklappt hat — nie ein Token.
 */
import { createHash, randomBytes } from "node:crypto";

const base = process.env.GROSSHANDEL_BASE_URL ?? "http://127.0.0.1:8787";
const tenant = process.env.GROSSHANDEL_TENANT ?? "pilot";
const email = process.env.LOGIN_EMAIL;
const code = process.env.LOGIN_CODE?.trim().toUpperCase();
if (!email || !code) {
  console.error("Bitte LOGIN_EMAIL und LOGIN_CODE setzen.");
  process.exit(1);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const clientId = "smoke-login";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Slug": tenant }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const auth = await post("/v1/auth/oauth/authorize", {
    client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
    scope: "customer_self", email, magic_link_code: code,
  });
  expect(auth.status === 200 && auth.json?.code, `authorize ${auth.status} ${JSON.stringify(auth.json)}`);
  console.log("✓ /oauth/authorize mit Login-Code + PKCE");

  const tok = await post("/v1/auth/oauth/token", { grant_type: "authorization_code", code: auth.json.code, code_verifier: verifier, client_id: clientId });
  expect(tok.status === 200 && tok.json?.access_token && tok.json?.refresh_token, `token ${tok.status} ${JSON.stringify(tok.json?.code ?? tok.json)}`);
  console.log("✓ /oauth/token → Access- und Refresh-Token");

  const again = await post("/v1/auth/oauth/token", { grant_type: "authorization_code", code: auth.json.code, code_verifier: verifier, client_id: clientId });
  expect(again.status >= 400, `derselbe Autorisierungscode ließ sich zweimal einlösen (${again.status})`);
  console.log(`✓ Autorisierungscode nur einmal einlösbar (${again.status})`);

  const me = await fetch(`${base}/v1/customer/me`, { headers: { Authorization: `Bearer ${tok.json.access_token}`, "X-Client-Version": "0.1.0", "X-Client-Platform": "ios" } });
  const meJson = await me.json() as { customer?: { email?: string } };
  expect(me.status === 200 && meJson.customer?.email === email, `me ${me.status}`);
  console.log("✓ Kunden-API mit dem neuen Token → eigenes Konto");

  const ref = await post("/v1/auth/oauth/token", { grant_type: "refresh_token", refresh_token: tok.json.refresh_token, client_id: clientId });
  expect(ref.status === 200 && ref.json?.access_token && ref.json?.refresh_token !== tok.json.refresh_token, `refresh ${ref.status} ${JSON.stringify(ref.json?.code ?? ref.json)}`);
  console.log("✓ Refresh → neues Token-Paar (rotiert)");

  const old = await post("/v1/auth/oauth/token", { grant_type: "refresh_token", refresh_token: tok.json.refresh_token, client_id: clientId });
  expect(old.status >= 400, `altes Refresh-Token gilt nach der Rotation noch (${old.status})`);
  console.log(`✓ altes Refresh-Token danach ungültig (${old.status} ${old.json?.code ?? ""})`);

  if (process.env.LOGIN_TOKEN_OUT) {
    // Nur für einen Folge-Smoke im selben Lauf: Datei, nie die Konsole.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.LOGIN_TOKEN_OUT, ref.json.access_token, { mode: 0o600 });
  }
  console.log("\n✓ Login-Smoke OK");
}

main().catch((e) => { console.error("✗ Login-Smoke failed:", e instanceof Error ? e.message : e); process.exit(1); });
export {};
