import { describe, expect, it } from "vitest";
import { verifyPkce, bytesToBase64Url } from "../../src/auth/pkce";
import { sha256Hex } from "../../src/lib/crypto";

describe("PKCE", () => {
  it("S256 verify matches challenge derived from verifier", async () => {
    const verifier = "x".repeat(64);
    const hex = await sha256Hex(verifier);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const challenge = bytesToBase64Url(bytes);
    expect(await verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("S256 mismatch rejects", async () => {
    const verifier = "x".repeat(64);
    const wrong = "wrong-challenge";
    expect(await verifyPkce(verifier, wrong, "S256")).toBe(false);
  });

  it("rejects non-S256 methods (plain removed per OAuth 2.1 / RFC 9700)", async () => {
    // @ts-expect-error — typesystem verbietet "plain", Runtime-Reject prüfen
    expect(await verifyPkce("abc", "abc", "plain")).toBe(false);
  });
});
