import { describe, expect, it } from "vitest";
import { isPiiKey, redactPii } from "../../src/observability/pii";

describe("pii-redaction", () => {
  it("isPiiKey matches expected fields", () => {
    expect(isPiiKey("email")).toBe(true);
    expect(isPiiKey("customer.email")).toBe(true);
    expect(isPiiKey("phone")).toBe(true);
    expect(isPiiKey("address.street")).toBe(true);
    expect(isPiiKey("vat_id")).toBe(true);
    expect(isPiiKey("password")).toBe(true);
    expect(isPiiKey("token")).toBe(true);
    expect(isPiiKey("status")).toBe(false);
    expect(isPiiKey("tenant_id")).toBe(false);
  });

  it("redactPii hashes top-level email", async () => {
    const out = await redactPii({ email: "hannes@example.com", route: "GET /v1/customers" });
    expect(out.email).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(out.route).toBe("GET /v1/customers");
  });

  it("redactPii hashes nested fields", async () => {
    const out = await redactPii({ customer: { id: "cust_1", email: "x@y.example", name: "Floraly" } });
    expect((out.customer as Record<string, string>).id).toBe("cust_1");
    expect((out.customer as Record<string, string>).email).toMatch(/^sha256:/);
    expect((out.customer as Record<string, string>).name).toMatch(/^sha256:/);
  });

  it("redactPii is deterministic — same input → same hash", async () => {
    const a = await redactPii({ email: "x@y.example" });
    const b = await redactPii({ email: "x@y.example" });
    expect(a.email).toBe(b.email);
  });

  it("redactPii passes arrays", async () => {
    const out = await redactPii({ list: [{ email: "a@b.example" }, { email: "c@d.example" }] });
    const list = out.list as Array<Record<string, string>>;
    expect(list[0]?.email).toMatch(/^sha256:/);
    expect(list[1]?.email).toMatch(/^sha256:/);
    expect(list[0]?.email).not.toBe(list[1]?.email);
  });
});
