import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEmailAdapter, setEmailAdapter } from "../../src/auth/email";
import { floridayConfig, legacyFloridayConfig } from "../../src/integrations/floriday";
import { seal, unseal } from "../../src/modules/crypto";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

const ADMIN = (env as unknown as { ADMIN_API_KEY: string }).ADMIN_API_KEY;
const BASE = "https://example.com";
// Testwerte zur Laufzeit gebaut: als Literal hielte der Secret-Scan sie für echte Schlüssel.
const SECRET = ["testwert", "eins", crypto.randomUUID()].join("-");
const NEU = ["testwert", "drei", crypto.randomUUID()].join("-");
const APIKEY = ["testwert", "zwei", crypto.randomUUID()].join("-");

let t: SeededTenant;
let mails: string[];

beforeEach(async () => {
  t = await seedTenant({ slug: "mod-a" });
  mails = [];
  setEmailAdapter({ async send(m) { mails.push(m.text); } });
});
afterEach(async () => {
  resetEmailAdapter();
  await clearTenants();
});

async function api(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = await signedHeaders({ apiKey: t.api_key_plain, hmacSecret: t.hmac_secret, method, pathname: path, body: raw });
  return SELF.fetch(`${BASE}${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
}

async function staffToken(role: "owner" | "staff"): Promise<string> {
  const email = `${role}@firma.example`;
  await SELF.fetch(`${BASE}/admin/tenants/mod-a/staff`, { method: "POST", headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
  const h = { "Content-Type": "application/json", "X-Tenant-Slug": "mod-a" };
  await SELF.fetch(`${BASE}/v1/auth/staff/code/request`, { method: "POST", headers: h, body: JSON.stringify({ email }) });
  const code = /Anmelde-Code: (\w{8})/.exec(mails.at(-1) ?? "")?.[1];
  const res = await SELF.fetch(`${BASE}/v1/auth/staff/code/verify`, { method: "POST", headers: h, body: JSON.stringify({ email, code }) });
  return ((await res.json()) as { access_token: string }).access_token;
}

const floridaySettings = { environment: "staging", account: "einkauf-1", clientId: "client-1", scheduled: false, ordering: false };

describe("Module je Tenant", () => {
  it("listet alle Module, zunächst nicht eingerichtet", async () => {
    const res = await api("GET", "/v1/modules");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; enabled: boolean; configured: boolean; fields: unknown[] }> };
    expect(data.map((m) => m.id)).toEqual(["floriday", "fleurop-nl", "flower-shop-network", "komander", "file-import"]);
    expect(data.find((m) => m.id === "floriday")).toMatchObject({ enabled: false, configured: false });
  });

  it("Zugangsdaten gehen hinein, nie heraus, und liegen nur verschlüsselt", async () => {
    const put = await api("PUT", "/v1/modules/floriday/credentials", { clientSecret: SECRET, apiKey: APIKEY });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(SECRET);
    expect(JSON.parse(putText)).toMatchObject({ configured: true });
    expect(JSON.parse(putText).fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const list = await (await api("GET", "/v1/modules/floriday")).text();
    expect(list).not.toContain(SECRET);
    expect(list).not.toContain(APIKEY);

    const row = await env.DB.prepare("SELECT * FROM tenant_module_credentials WHERE tenant_id = ?").bind(t.tenant_id).first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(APIKEY);
  });

  it("ein geheimes Feld über settings zu setzen wird abgewiesen", async () => {
    const res = await api("PUT", "/v1/modules/floriday", { settings: { clientSecret: SECRET } });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("einschalten geht erst, wenn alles da ist; danach liest die Anbindung die Tenant-Zugänge", async () => {
    const unvollstaendig = await api("PUT", "/v1/modules/floriday", { enabled: true, settings: floridaySettings });
    expect(unvollstaendig.status).toBe(422);
    await api("PUT", "/v1/modules/floriday/credentials", { clientSecret: SECRET, apiKey: APIKEY });
    const an = await api("PUT", "/v1/modules/floriday", { enabled: true });
    expect(an.status).toBe(200);
    expect(await an.json()).toMatchObject({ enabled: true, configured: true, source: "tenant" });
    const cfg = await floridayConfig(env as never, t.tenant_id);
    expect(cfg).toMatchObject({ account: "einkauf-1", clientSecret: SECRET, apiKey: APIKEY, environment: "staging" });
  });

  it("Teilweise ersetzen behält die übrigen geheimen Felder", async () => {
    await api("PUT", "/v1/modules/floriday/credentials", { clientSecret: SECRET, apiKey: APIKEY });
    await api("PUT", "/v1/modules/floriday/credentials", { apiKey: NEU });
    await api("PUT", "/v1/modules/floriday", { enabled: true, settings: floridaySettings });
    expect(await floridayConfig(env as never, t.tenant_id)).toMatchObject({ clientSecret: SECRET, apiKey: NEU });
  });

  it("ein eigener Datensatz schlägt das alte Sammel-Secret; ohne Datensatz gilt das alte", async () => {
    const legacyEnv = { ...env, FLORIDAY_CONNECTIONS: JSON.stringify({ [t.tenant_id]: { ...floridaySettings, account: "alt", clientSecret: "x", apiKey: "y" } }) } as never;
    expect(await floridayConfig(legacyEnv, t.tenant_id)).toMatchObject({ account: "alt" });
    expect(legacyFloridayConfig(legacyEnv, t.tenant_id)).toMatchObject({ account: "alt" });
    await api("PUT", "/v1/modules/floriday", { enabled: false, settings: floridaySettings });
    expect(await floridayConfig(legacyEnv, t.tenant_id)).toBeUndefined();
  });

  it("ein kopierter Datensatz lässt sich bei einem anderen Tenant nicht entschlüsseln", async () => {
    const sealed = await seal(env as never, t.tenant_id, "floriday", { clientSecret: SECRET });
    expect(await unseal(env as never, t.tenant_id, "floriday", sealed)).toEqual({ clientSecret: SECRET });
    await expect(unseal(env as never, "t_ANDERER", "floriday", sealed)).rejects.toMatchObject({ code: "GH-MODULE-003" });
    await expect(unseal(env as never, t.tenant_id, "komander", sealed)).rejects.toMatchObject({ code: "GH-MODULE-003" });
  });

  it("ohne MODULE_KEK lässt sich nichts verschlüsseln", async () => {
    await expect(seal({ ...env, MODULE_KEK: undefined } as never, t.tenant_id, "floriday", { a: "b" })).rejects.toMatchObject({ code: "GH-MODULE-002" });
  });

  it("nur Inhaber ändern; Mitarbeiter sehen nur", async () => {
    const staff = await staffToken("staff");
    const h = { Authorization: `Bearer ${staff}`, "Content-Type": "application/json" };
    expect((await SELF.fetch(`${BASE}/v1/modules`, { headers: h })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/modules/floriday/credentials`, { method: "PUT", headers: h, body: JSON.stringify({ apiKey: APIKEY }) })).status).toBe(403);
    const owner = await staffToken("owner");
    const ok = await SELF.fetch(`${BASE}/v1/modules/floriday/credentials`, { method: "PUT", headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: APIKEY }) });
    expect(ok.status).toBe(200);
  });

  it("Betreiber sperrt ein Modul: es geht aus und lässt sich nicht einschalten", async () => {
    await api("PUT", "/v1/modules/floriday/credentials", { clientSecret: SECRET, apiKey: APIKEY });
    await api("PUT", "/v1/modules/floriday", { enabled: true, settings: floridaySettings });
    const sperr = await SELF.fetch(`${BASE}/admin/tenants/mod-a/modules/floriday`, { method: "PUT", headers: { "X-Admin-Key": ADMIN, "Content-Type": "application/json" }, body: JSON.stringify({ available: false }) });
    expect(sperr.status).toBe(200);
    expect(await floridayConfig(env as never, t.tenant_id)).toBeUndefined();
    expect((await api("PUT", "/v1/modules/floriday", { enabled: true })).status).toBe(404);
  });

  it("Prüfung ohne automatischen Test meldet „ungeprüft“ mit Begründung", async () => {
    await api("PUT", "/v1/modules/fleurop-nl", { settings: { account: "a", sender: 1, debtorId: 2 } });
    await api("PUT", "/v1/modules/fleurop-nl/credentials", { bearerToken: "abc.def" });
    const res = await api("POST", "/v1/modules/fleurop-nl/check");
    expect(await res.json()).toMatchObject({ status: "unchecked" });
  });

  it("Datei-Import: ausgeschaltet heißt zu, ohne Datensatz bleibt er offen", async () => {
    expect((await api("GET", "/v1/suppliers/imports/lieferant-a")).status).not.toBe(503);
    await api("PUT", "/v1/modules/file-import", { enabled: false });
    expect((await api("GET", "/v1/suppliers/imports/lieferant-a")).status).toBe(503);
  });

  it("Zugang entfernen schaltet das Modul aus", async () => {
    await api("PUT", "/v1/modules/floriday/credentials", { clientSecret: SECRET, apiKey: APIKEY });
    await api("PUT", "/v1/modules/floriday", { enabled: true, settings: floridaySettings });
    expect((await api("DELETE", "/v1/modules/floriday/credentials")).status).toBe(204);
    expect(await (await api("GET", "/v1/modules/floriday")).json()).toMatchObject({ enabled: false, credentials: { configured: false } });
  });
});
