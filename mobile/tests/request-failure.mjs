import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRequestFailure } from "../src/request-failure.ts";

const internal_detail = "interne Diagnose";
for (const [status, code, message] of [
  [404, "GH-TENANT-001", /Betrieb ist nicht eingerichtet/],
  [503, "GH-EXT-003", /Anmeldung per E-Mail ist gerade nicht möglich/],
  [410, "GH-AUTH-006", /falsch oder abgelaufen/],
  [429, "GH-AUTH-006", /in einer Minute erneut/],
  [500, "GH-UNKNOWN", /Vorgangsnummer: req_demo/],
]) {
  test(`HTTP ${status} mit ${code}`, async () => {
    const result = await describeRequestFailure(Response.json({ code, internal_detail, instance: "req_demo" }, { status }));
    assert.match(result.message, message);
    assert.ok(!result.message.includes(internal_detail));
    assert.equal(result.code, status === 429 ? "RATE" : code);
    if (status === 429) assert.equal(result.retryAfter, 60);
  });
}

test("Netzwerkfehler", async () => {
  assert.deepEqual(await describeRequestFailure(), {
    message: "Keine Verbindung zum Bestellservice.",
    code: "NETWORK",
  });
});

test("Retry-After wird berücksichtigt", async () => {
  const result = await describeRequestFailure(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
  assert.equal(result.retryAfter, 120);
  assert.match(result.message, /in 2 Minuten erneut/);
});

test("Antwort ohne Problem-JSON", async () => {
  const result = await describeRequestFailure(new Response("Gateway Error", { status: 502 }));
  assert.equal(result.message, "Der Bestellservice konnte die Anfrage nicht abschließen.");
  assert.equal(result.code, "HTTP-502");
});
