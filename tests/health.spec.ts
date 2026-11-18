import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns 200 with status, version, commit, environment", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.commit).toBe("string");
    expect(typeof body.environment).toBe("string");
  });

  it("echoes incoming X-Request-Id when provided", async () => {
    const customId = "01TESTREQUESTID000000000000";
    const res = await SELF.fetch("https://example.com/health", {
      headers: { "X-Request-Id": customId },
    });
    expect(res.headers.get("X-Request-Id")).toBe(customId);
  });

  it("returns RFC-7807 problem+json on unknown route", async () => {
    const res = await SELF.fetch("https://example.com/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.title).toBeTruthy();
    expect(body.instance).toBeTruthy();
  });
});
