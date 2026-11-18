import { SELF } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { auth } from "../../src/middleware/auth";
import type { AppContext } from "../../src/env";
import { clearTenants, seedTenant } from "../_setup/seed";
import { signedHeaders } from "../_setup/sign";

// Wir mounten temporäre Routes auf dem laufenden Worker via einer Echo-Route
// in v1, indem wir einen Probe-Endpoint definieren. Da SELF unser exportiertes
// Default-App ist und v1 mit auth+idempotency geschützt ist, reicht ein hier
// vorhandener Endpoint nicht — daher: wir testen Auth mit der existierenden
// /v1-Hierarchie und einer ad-hoc nicht existenten Route, die aber die
// auth-Middleware durchläuft (Auth wirft *vor* Routing-404).

afterEach(async () => {
  await clearTenants();
});

const PROBE_PATH = "/v1/_probe";

describe("auth middleware", () => {
  it("missing X-Api-Key → 401 GH-AUTH-001", async () => {
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-AUTH-001");
  });

  it("missing X-Signature → 401 GH-AUTH-002", async () => {
    const t = await seedTenant();
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`, {
      headers: { "X-Api-Key": t.api_key_plain, "X-Timestamp": String(Math.floor(Date.now() / 1000)) },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("GH-AUTH-002");
  });

  it("timestamp out of skew → 401 GH-AUTH-003", async () => {
    const t = await seedTenant();
    const headers = await signedHeaders({
      apiKey: t.api_key_plain,
      hmacSecret: t.hmac_secret,
      method: "GET",
      pathname: PROBE_PATH,
      timestamp: Math.floor(Date.now() / 1000) - 1000,
    });
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("GH-AUTH-003");
  });

  it("unknown api key → 401 GH-AUTH-001", async () => {
    const headers = await signedHeaders({
      apiKey: "gh_unknownkey",
      hmacSecret: "wrong",
      method: "GET",
      pathname: PROBE_PATH,
    });
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("GH-AUTH-001");
  });

  it("HMAC mismatch (wrong secret) → 401 GH-AUTH-002", async () => {
    const t = await seedTenant();
    const headers = await signedHeaders({
      apiKey: t.api_key_plain,
      hmacSecret: "wrong-secret",
      method: "GET",
      pathname: PROBE_PATH,
    });
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("GH-AUTH-002");
  });

  it("valid signed request passes auth → 404 (route not registered)", async () => {
    const t = await seedTenant();
    const headers = await signedHeaders({
      apiKey: t.api_key_plain,
      hmacSecret: t.hmac_secret,
      method: "GET",
      pathname: PROBE_PATH,
    });
    const res = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers });
    // Auth durchgelaufen, aber idempotency wird auf POST/PUT/PATCH/DELETE only triggered,
    // und die Route existiert nicht → 404 problem+json.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

// Direkter Unit-Test für tenant_id-Setting via lokaler Hono-App
describe("auth middleware sets tenant_id", () => {
  it("c.var.tenant_id ist gesetzt nach erfolgreichem auth", async () => {
    const t = await seedTenant();
    const localApp = new Hono<AppContext>();
    localApp.use("*", async (c, next) => {
      // emulate request-id middleware
      c.set("request_id", "test-req-1");
      await next();
    });
    localApp.use("*", auth());
    localApp.get("/who", (c) => c.json({ tenant_id: c.var.tenant_id, api_key_id: c.var.api_key_id }));

    const headers = await signedHeaders({
      apiKey: t.api_key_plain,
      hmacSecret: t.hmac_secret,
      method: "GET",
      pathname: "/who",
    });
    const { env } = await import("cloudflare:test");
    const res = await localApp.request("/who", { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant_id: string; api_key_id: string };
    expect(body.tenant_id).toBe(t.tenant_id);
    expect(body.api_key_id).toBe(t.api_key_id);
  });
  it("Replay-Schutz: dieselbe Signatur bei einem POST greift nur einmal", async () => {
    const t = await seedTenant();
    const h = await signedHeaders({ apiKey: t.api_key_plain, hmacSecret: t.hmac_secret, method: "POST", pathname: PROBE_PATH, body: "{}" });
    const first = await SELF.fetch(`https://example.com${PROBE_PATH}`, { method: "POST", headers: h, body: "{}" });
    expect(first.status).not.toBe(401);
    const second = await SELF.fetch(`https://example.com${PROBE_PATH}`, { method: "POST", headers: h, body: "{}" });
    expect(second.status).toBe(401);
  });

  it("zwei identische GETs in derselben Sekunde werden beide angenommen (Lesen ist kein Replay-Risiko)", async () => {
    const t = await seedTenant();
    const h = await signedHeaders({ apiKey: t.api_key_plain, hmacSecret: t.hmac_secret, method: "GET", pathname: PROBE_PATH });
    const a = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers: h });
    const b = await SELF.fetch(`https://example.com${PROBE_PATH}`, { headers: h });
    expect(a.status).not.toBe(401);
    expect(b.status).not.toBe(401);
  });
});
