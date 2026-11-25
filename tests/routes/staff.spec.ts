import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEmailAdapter, setEmailAdapter } from "../../src/auth/email";
import { issueTokenPair } from "../../src/auth/token-issuance";
import { requestStaffCode, verifyStaffCode } from "../../src/auth/staff";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";

const ADMIN = (env as unknown as { ADMIN_API_KEY: string }).ADMIN_API_KEY;
const BASE = "https://example.com";
const CLIENT = { "X-Client-Version": "1.0.0", "X-Client-Platform": "ios" };

let t: SeededTenant;
let mails: Array<{ to: string; text: string }>;

beforeEach(async () => {
  t = await seedTenant({ slug: "staff-a" });
  mails = [];
  setEmailAdapter({ async send(m) { mails.push({ to: m.to, text: m.text }); } });
});
afterEach(async () => {
  resetEmailAdapter();
  await env.DB.prepare("DELETE FROM customers").run();
  await clearTenants();
});

async function addViaAdmin(email: string, role?: string) {
  return SELF.fetch(`${BASE}/admin/tenants/staff-a/staff`, {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, ...(role ? { role } : {}) }),
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant-Slug": "staff-a", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(email: string): Promise<string> {
  expect((await post("/v1/auth/staff/code/request", { email })).status).toBe(200);
  const code = /Anmelde-Code: ([2-9A-HJ-NP-Z]{8})/.exec(mails.at(-1)?.text ?? "")?.[1];
  expect(code).toBeTruthy();
  const res = await post("/v1/auth/staff/code/verify", { email, code });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const bearer = (tok: string) => ({ Authorization: `Bearer ${tok}` });

describe("Mitarbeiter-Anmeldung", () => {
  it("Inhaber anlegen (Admin), per Code anmelden, Tenant-API mit dem Token nutzen", async () => {
    expect((await addViaAdmin("Chefin@Firma.example")).status).toBe(201);
    const tok = await login("chefin@firma.example");
    const me = await SELF.fetch(`${BASE}/v1/staff/me`, { headers: bearer(tok) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "chefin@firma.example", role: "owner" });
    expect((await SELF.fetch(`${BASE}/v1/customers`, { headers: bearer(tok) })).status).toBe(200);
  });

  it("unbekannte Adresse: gleiche Antwort, keine Mail", async () => {
    const res = await post("/v1/auth/staff/code/request", { email: "niemand@firma.example" });
    expect(res.status).toBe(200);
    expect(mails).toHaveLength(0);
  });

  it("Kunden-Token kommt nicht in den Tenant-Bereich, Mitarbeiter-Token nicht in den Kundenbereich", async () => {
    const cust = await SELF.fetch(`${BASE}/v1/customers`, { method: "GET" });
    expect(cust.status).toBe(401);
    await env.DB.prepare("INSERT INTO customers (id, tenant_id, name, email, country, b2b_b2c, created_at, updated_at) VALUES ('cust_x', ?, 'K', 'k@firma.example', 'DE', 'b2b', ?, ?)")
      .bind(t.tenant_id, new Date().toISOString(), new Date().toISOString()).run();
    const pair = await issueTokenPair(env as never, t.tenant_id, "cust_x", ["customer_self"]);
    expect((await SELF.fetch(`${BASE}/v1/customers`, { headers: bearer(pair.access_token) })).status).toBe(401);

    await addViaAdmin("chef@firma.example");
    const staffTok = await login("chef@firma.example");
    expect((await SELF.fetch(`${BASE}/v1/customer/me`, { headers: { ...CLIENT, ...bearer(staffTok) } })).status).toBe(401);
  });

  it("nach fünf Fehlversuchen gilt auch der richtige Code nicht mehr (Dienst, ohne Rate-Limit)", async () => {
    await addViaAdmin("chef@firma.example");
    const r = await requestStaffCode(env as never, t.tenant_id, "chef@firma.example");
    const code = r.code as string;
    const falsch = code[0] === "A" ? "B" + code.slice(1) : "A" + code.slice(1);
    for (let i = 0; i < 5; i++) {
      await expect(verifyStaffCode(env as never, t.tenant_id, "chef@firma.example", falsch)).rejects.toMatchObject({ code: "GH-AUTH-006" });
    }
    await expect(verifyStaffCode(env as never, t.tenant_id, "chef@firma.example", code)).rejects.toMatchObject({ code: "GH-AUTH-006" });
  });

  it("über HTTP bremst zusätzlich das Rate-Limit (5 je Minute)", async () => {
    await addViaAdmin("chef@firma.example");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("/v1/auth/staff/code/verify", { email: "chef@firma.example", code: "AAAAAAAA" })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("ein Code gilt einmal", async () => {
    await addViaAdmin("chef@firma.example");
    await post("/v1/auth/staff/code/request", { email: "chef@firma.example" });
    const code = /Anmelde-Code: (\w{8})/.exec(mails.at(-1)?.text ?? "")?.[1] as string;
    expect((await post("/v1/auth/staff/code/verify", { email: "chef@firma.example", code })).status).toBe(200);
    expect((await post("/v1/auth/staff/code/verify", { email: "chef@firma.example", code })).status).toBe(410);
  });

  it("nur der Inhaber verwaltet Mitarbeiter; gesperrt ist sofort draußen", async () => {
    await addViaAdmin("chef@firma.example");
    const owner = await login("chef@firma.example");
    const add = await SELF.fetch(`${BASE}/v1/staff`, { method: "POST", headers: { ...bearer(owner), "Content-Type": "application/json" }, body: JSON.stringify({ email: "lager@firma.example" }) });
    expect(add.status).toBe(201);
    const lagerId = ((await add.json()) as { id: string }).id;

    const lager = await login("lager@firma.example");
    expect((await SELF.fetch(`${BASE}/v1/staff`, { headers: bearer(lager) })).status).toBe(200);
    const versuch = await SELF.fetch(`${BASE}/v1/staff`, { method: "POST", headers: { ...bearer(lager), "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@firma.example" }) });
    expect(versuch.status).toBe(403);

    expect((await SELF.fetch(`${BASE}/v1/staff/${lagerId}`, { method: "DELETE", headers: bearer(owner) })).status).toBe(204);
    expect((await SELF.fetch(`${BASE}/v1/customers`, { headers: bearer(lager) })).status).toBe(401);
  });

  it("doppelte Adresse: 409", async () => {
    expect((await addViaAdmin("chef@firma.example")).status).toBe(201);
    expect((await addViaAdmin("CHEF@firma.example")).status).toBe(409);
  });

  it("CORS: Dashboard-Origin darf den Tenant-Bereich, aber nicht den Kundenbereich", async () => {
    const pre = (path: string, origin: string) => SELF.fetch(`${BASE}${path}`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
    expect((await pre("/v1/customers", "https://admin.pilot.example")).headers.get("Access-Control-Allow-Origin")).toBe("https://admin.pilot.example");
    expect((await pre("/v1/customers", "https://boese.example")).headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await pre("/v1/customer/me", "https://admin.pilot.example")).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
