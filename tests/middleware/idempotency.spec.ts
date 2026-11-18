import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { idempotency } from "../../src/middleware/idempotency";
import type { AppContext } from "../../src/env";

afterEach(async () => {
  // KV cleanup
  const list = await env.KV.list({ prefix: "idemp:" });
  for (const k of list.keys) await env.KV.delete(k.name);
});

function buildApp(): Hono<AppContext> {
  const app = new Hono<AppContext>();
  app.use("*", async (c, next) => {
    c.set("request_id", "test-req");
    c.set("tenant_id", "t_test");
    await next();
  });
  app.use("*", idempotency());
  let counter = 0;
  app.post("/echo", async (c) => {
    counter += 1;
    const body = await c.req.json().catch(() => ({}));
    return c.json({ counter, body });
  });
  return app;
}

describe("idempotency middleware", () => {
  it("ohne X-Idempotency-Key passiert nichts (kein Cache)", async () => {
    const app = buildApp();
    const r1 = await app.request("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) }, env);
    const r2 = await app.request("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) }, env);
    const b1 = (await r1.json()) as { counter: number };
    const b2 = (await r2.json()) as { counter: number };
    expect(b1.counter).not.toBe(b2.counter);
  });

  it("gleicher Key + gleicher Body → identische Response, X-Idempotency-Hit=true", async () => {
    const app = buildApp();
    const headers = { "Content-Type": "application/json", "X-Idempotency-Key": "k-1" };
    const body = JSON.stringify({ a: 42 });
    const r1 = await app.request("/echo", { method: "POST", headers, body }, env);
    const r2 = await app.request("/echo", { method: "POST", headers, body }, env);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-Idempotency-Hit")).toBe("true");
    expect(await r1.text()).toBe(await r2.text());
  });

  it("gleicher Key + anderer Body → 409 GH-IDEMP-001", async () => {
    // Lokale App mit errorHandler, damit CodedError → problem+json wird.
    const { errorHandler } = await import("../../src/middleware/error");
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("request_id", "test-req");
      c.set("tenant_id", "t_test");
      await next();
    });
    app.onError(errorHandler);
    app.use("*", idempotency());
    let counter = 0;
    app.post("/echo", async (c) => {
      counter += 1;
      const body = await c.req.json().catch(() => ({}));
      return c.json({ counter, body });
    });

    const r1 = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "k-2" },
      body: JSON.stringify({ a: 1 }),
    }, env);
    expect(r1.status).toBe(200);

    const r2 = await app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": "k-2" },
      body: JSON.stringify({ a: 2 }),
    }, env);
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-IDEMP-001");
  });

  it("GET-Requests werden ignoriert (kein Caching)", async () => {
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => { c.set("request_id", "x"); c.set("tenant_id", "t_t"); await next(); });
    app.use("*", idempotency());
    let n = 0;
    app.get("/g", (c) => c.json({ n: ++n }));
    const headers = { "X-Idempotency-Key": "g-1" };
    const r1 = await app.request("/g", { headers }, env);
    const r2 = await app.request("/g", { headers }, env);
    const b1 = (await r1.json()) as { n: number };
    const b2 = (await r2.json()) as { n: number };
    expect(b1.n).not.toBe(b2.n);
  });
});
