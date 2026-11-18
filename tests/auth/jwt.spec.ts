import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "../../src/auth/jwt";

const SECRET = "test-secret-1234567890abcdef"; // gitleaks:allow -- Test-Fixture, kein echter Schluessel

const basePayload = {
  iss: "tenants:t_abc",
  sub: "cust_123",
  aud: "grosshandel.api",
  scope: ["customer_self"],
  tenant_id: "t_abc",
};

describe("jwt sign+verify (HS256)", () => {
  it("round-trips a valid token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await signJwt({ ...basePayload, exp: now + 60, iat: now }, SECRET);
    const v = await verifyJwt(tok, SECRET, "t_abc");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.sub).toBe("cust_123");
  });

  it("rejects when expired (over skew tolerance)", async () => {
    // #A-004: 60s Clock-Skew akzeptiert; muss > 60s in der Vergangenheit sein.
    const now = Math.floor(Date.now() / 1000);
    const tok = await signJwt({ ...basePayload, exp: now - 120, iat: now - 600 }, SECRET);
    const v = await verifyJwt(tok, SECRET, "t_abc");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("accepts within skew tolerance (~60s grace)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await signJwt({ ...basePayload, exp: now - 30, iat: now - 600 }, SECRET);
    const v = await verifyJwt(tok, SECRET, "t_abc");
    expect(v.ok).toBe(true);
  });

  it("rejects bad signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await signJwt({ ...basePayload, exp: now + 60, iat: now }, SECRET);
    const v = await verifyJwt(tok, "WRONG-SECRET", "t_abc");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  it("rejects wrong tenant", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await signJwt({ ...basePayload, exp: now + 60, iat: now }, SECRET);
    const v = await verifyJwt(tok, SECRET, "t_DIFFERENT");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("wrong_tenant");
  });

  it("rejects malformed token", async () => {
    const v = await verifyJwt("not.a.token", SECRET);
    expect(v.ok).toBe(false);
  });
});
