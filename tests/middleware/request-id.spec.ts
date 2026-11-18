import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId } from "../../src/middleware/request-id";
import type { AppContext } from "../../src/env";

describe("request-id middleware", () => {
  it("generates a request id when none is provided", async () => {
    const app = new Hono<AppContext>();
    app.use("*", requestId());
    app.get("/", (c) => c.text(c.var.request_id));
    const res = await app.request("/", {}, env);
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect((id ?? "").length).toBeGreaterThan(10);
  });

  it("echoes incoming X-Request-Id verbatim", async () => {
    const app = new Hono<AppContext>();
    app.use("*", requestId());
    app.get("/", (c) => c.text(c.var.request_id));
    const res = await app.request("/", { headers: { "X-Request-Id": "custom-abc-123" } }, env);
    expect(res.headers.get("X-Request-Id")).toBe("custom-abc-123");
  });
});
