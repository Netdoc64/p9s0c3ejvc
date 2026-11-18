import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt, type JwtPayload } from "../../src/auth/jwt";

const SECRET_CURRENT = "current-secret-32-bytes-padding!";
const SECRET_PREVIOUS = "previous-secret-32-bytes-pad!!!!";

const basePayload: JwtPayload = {
  iss: "tenants:t_abc",
  sub: "cust_1",
  aud: "grosshandel.api",
  exp: Math.floor(Date.now() / 1000) + 60,
  iat: Math.floor(Date.now() / 1000),
  scope: ["customer_self"],
  tenant_id: "t_abc",
};

describe("JWT kid + Doppel-Reader (#A-005)", () => {
  it("verifies token signed with current secret", async () => {
    const tok = await signJwt(basePayload, SECRET_CURRENT, "current");
    const r = await verifyJwt(tok, { current: SECRET_CURRENT, previous: SECRET_PREVIOUS }, "t_abc");
    expect(r.ok).toBe(true);
  });

  it("falls back to previous secret if current does not match", async () => {
    const tok = await signJwt(basePayload, SECRET_PREVIOUS, "previous");
    const r = await verifyJwt(tok, { current: SECRET_CURRENT, previous: SECRET_PREVIOUS }, "t_abc");
    expect(r.ok).toBe(true);
  });

  it("rejects when neither secret matches", async () => {
    const tok = await signJwt(basePayload, "other-secret", "current");
    const r = await verifyJwt(tok, { current: SECRET_CURRENT, previous: SECRET_PREVIOUS }, "t_abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("backward-compat: string secret still works", async () => {
    const tok = await signJwt(basePayload, SECRET_CURRENT);
    const r = await verifyJwt(tok, SECRET_CURRENT, "t_abc");
    expect(r.ok).toBe(true);
  });

  it("rejects iss mismatch", async () => {
    const tok = await signJwt({ ...basePayload, iss: "tenants:t_other" }, SECRET_CURRENT);
    const r = await verifyJwt(tok, SECRET_CURRENT, "t_abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_iss");
  });

  it("rejects future iat", async () => {
    const tok = await signJwt({ ...basePayload, iat: Math.floor(Date.now() / 1000) + 600 }, SECRET_CURRENT);
    const r = await verifyJwt(tok, SECRET_CURRENT, "t_abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("future_iat");
  });
});
