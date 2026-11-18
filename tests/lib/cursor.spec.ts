import { describe, expect, it } from "vitest";
import { signCursor, verifyCursor } from "../../src/lib/cursor";
import type { Env } from "../../src/env";

const fakeEnv = { WORKER_VERSION: "0.1.0", GIT_COMMIT: "test" } as unknown as Env;

describe("signed cursor (#T-008)", () => {
  it("round-trips payload", async () => {
    const payload = { created_at: "2026-05-02T10:00:00Z", id: "ord_abc" };
    const cursor = await signCursor(fakeEnv, payload);
    const decoded = await verifyCursor<typeof payload>(fakeEnv, cursor);
    expect(decoded).toEqual(payload);
  });

  it("rejects tampered payload", async () => {
    const payload = { created_at: "2026-05-02T10:00:00Z", id: "ord_abc" };
    const cursor = await signCursor(fakeEnv, payload);
    // Cursor is base64url(JSON({p, s})). Tamper by decoding and changing payload.
    const padNeeded = (4 - (cursor.length % 4)) % 4;
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padNeeded);
    const decoded = JSON.parse(atob(b64));
    decoded.p.id = "ord_evil";
    const tampered = btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(() => verifyCursor(fakeEnv, tampered)).rejects.toThrow();
  });

  it("rejects malformed input", async () => {
    await expect(() => verifyCursor(fakeEnv, "not-base64-json")).rejects.toThrow();
  });

  it("rejects cursor signed with different secret (env-bound)", async () => {
    const payload = { created_at: "2026-05-02T10:00:00Z", id: "ord_abc" };
    const cursor = await signCursor(fakeEnv, payload);
    const otherEnv = { WORKER_VERSION: "0.1.1", GIT_COMMIT: "different" } as unknown as Env;
    await expect(() => verifyCursor(otherEnv, cursor)).rejects.toThrow();
  });
});
