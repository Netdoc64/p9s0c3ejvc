import { afterEach, describe, expect, it } from "vitest";
import { CloudflareEmailAdapter, consoleEmailAdapter, email, resetEmailAdapter, setEmailAdapter, type SendEmailBinding } from "../../src/auth/email";

afterEach(() => resetEmailAdapter());

function fakeBinding(): SendEmailBinding & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, async send(m) { sent.push(m); return { messageId: "m1" }; } };
}

describe("email(env)", () => {
  it("nimmt Cloudflare Email, wenn Binding und Absender da sind", () => {
    expect(email({ ENVIRONMENT: "production", EMAIL: fakeBinding(), MAIL_FROM: "login@pilot.example" })).toBeInstanceOf(CloudflareEmailAdapter);
  });

  it("gibt außerhalb von development OHNE vollständige Konfiguration null zurück — nie still den console-Sink", () => {
    expect(email({ ENVIRONMENT: "staging" })).toBeNull();
    expect(email({ ENVIRONMENT: "production", EMAIL: fakeBinding() })).toBeNull();
    expect(email({ ENVIRONMENT: "production", MAIL_FROM: "login@pilot.example" })).toBeNull();
  });

  it("nimmt in development den console-Sink", () => {
    expect(email({ ENVIRONMENT: "development" })).toBe(consoleEmailAdapter);
  });

  it("der Test-Override schlägt alles", () => {
    const fake = { async send() {} };
    setEmailAdapter(fake);
    expect(email({ ENVIRONMENT: "production" })).toBe(fake);
  });
});

describe("CloudflareEmailAdapter", () => {
  it("schickt an das Binding mit Absender-Objekt und Text", async () => {
    const b = fakeBinding();
    await new CloudflareEmailAdapter(b, "login@pilot.example").send({ to: "kunde@pilot.example", subject: "Code", text: "123" });
    expect(b.sent).toEqual([{ to: "kunde@pilot.example", from: { email: "login@pilot.example", name: "Grosshandel" }, subject: "Code", text: "123" }]);
  });

  it("lässt Fehler des Bindings durch, statt sie zu schlucken", async () => {
    const b: SendEmailBinding = { async send() { throw Object.assign(new Error("not verified"), { code: "E_SENDER_NOT_VERIFIED" }); } };
    await expect(new CloudflareEmailAdapter(b, "x@pilot.example").send({ to: "a@pilot.example", subject: "s", text: "t" })).rejects.toThrow("not verified");
  });
});
