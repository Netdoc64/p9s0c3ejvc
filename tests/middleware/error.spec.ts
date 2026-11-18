import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/middleware/error";
import { requestId } from "../../src/middleware/request-id";
import { CodedError } from "../../src/errors/catalog";
import type { AppContext } from "../../src/env";

describe("error middleware (RFC 7807)", () => {
  function app() {
    const a = new Hono<AppContext>();
    a.use("*", requestId());
    a.onError(errorHandler);
    a.get("/ok", (c) => c.json({ ok: true }));
    a.get("/coded", () => {
      throw new CodedError("GH-AUTH-001");
    });
    a.get("/unknown", () => {
      throw new Error("boom");
    });
    return a;
  }

  it("CodedError → problem+json mit code, status, instance=request_id", async () => {
    const res = await app().request("/coded", {}, env);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-AUTH-001");
    expect(body.status).toBe(401);
    expect(body.instance).toBe(res.headers.get("X-Request-Id"));
  });

  it("Unknown Error → 500 GH-INFRA-002", async () => {
    const res = await app().request("/unknown", {}, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("GH-INFRA-002");
  });
});
