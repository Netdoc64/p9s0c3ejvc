import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("security-headers middleware (#L-003)", () => {
  it("sets HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy on /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Permissions-Policy")).toBeTruthy();
  });
});

describe("CORS middleware (#L-004)", () => {
  it("allows OPTIONS preflight for /v1/auth/*", async () => {
    const res = await SELF.fetch("https://example.com/v1/auth/magic-link/request", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("does NOT add CORS for tenant-API paths", async () => {
    const res = await SELF.fetch("https://example.com/v1/customers", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });
    // Tenant-API path doesn't get CORS - preflight should fall through
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(null);
  });
});
