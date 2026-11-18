import { describe, expect, it } from "vitest";
import { validatePublicHttpsUrl } from "../../src/lib/url-validation";

describe("validatePublicHttpsUrl (#T-005)", () => {
  it("accepts public https URL", () => {
    expect(validatePublicHttpsUrl("https://api.example.com/webhook").ok).toBe(true);
  });

  it("rejects http://", () => {
    const r = validatePublicHttpsUrl("http://api.example.com/webhook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("https_required");
  });

  it("rejects localhost", () => {
    const r = validatePublicHttpsUrl("https://localhost/webhook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname_blocked");
  });

  it("rejects *.local", () => {
    expect(validatePublicHttpsUrl("https://service.local/").ok).toBe(false);
  });

  it("rejects IPv4 private 10/8", () => {
    expect(validatePublicHttpsUrl("https://10.0.0.1/").ok).toBe(false);
  });

  it("rejects IPv4 private 192.168/16", () => {
    expect(validatePublicHttpsUrl("https://192.168.1.1/").ok).toBe(false);
  });

  it("rejects IPv4 link-local 169.254/16 (AWS metadata)", () => {
    expect(validatePublicHttpsUrl("https://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("rejects loopback 127/8", () => {
    expect(validatePublicHttpsUrl("https://127.0.0.1/").ok).toBe(false);
  });

  it("rejects CGNAT 100.64/10", () => {
    expect(validatePublicHttpsUrl("https://100.64.0.1/").ok).toBe(false);
  });

  it("rejects IPv6 ::1", () => {
    expect(validatePublicHttpsUrl("https://[::1]/").ok).toBe(false);
  });

  it("rejects IPv6 unique-local fc00::/7", () => {
    expect(validatePublicHttpsUrl("https://[fc00::1]/").ok).toBe(false);
  });

  it("rejects userinfo URLs", () => {
    const r = validatePublicHttpsUrl("https://user:pass@api.example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("userinfo_not_allowed");
  });

  it("rejects malformed URL", () => {
    expect(validatePublicHttpsUrl("not a url").ok).toBe(false);
  });
});
