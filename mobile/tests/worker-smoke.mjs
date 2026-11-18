import assert from "node:assert/strict";
import { chromium } from "playwright";
const api = process.env.PILOT_WORKER_URL;
const web = process.env.PILOT_SMOKE_URL;
assert(api && web, "Run this integration test through scripts/test-mobile-local.mjs.");
assert.equal(new URL(api).hostname, "127.0.0.1");
assert.equal(new URL(web).hostname, "127.0.0.1");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
const issues = [];
page.on("pageerror", (error) => issues.push(error.message));
async function login(email, expected = "Katalog") {
  await page.getByRole("textbox", { name: "Geschäftliche E-Mail-Adresse" }).fill(email);
  const response = page.waitForResponse((reply) => reply.url().endsWith("/v1/auth/magic-link/request") && reply.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern", exact: true }).click();
  assert.equal((await response).status(), 200);
  const { code } = await (await fetch(`${api}/__test/mail?email=${encodeURIComponent(email)}`)).json();
  assert.match(code, /^[2-9A-HJ-NP-Z]{8}$/);
  await page.getByRole("textbox", { name: "Achtstelliger Code" }).fill(code);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await page.getByRole("heading", { name: expected, exact: true }).waitFor();
}
async function draft() {
  await page.getByRole("textbox", { name: "Name oder Artikelnummer" }).fill("RO-MOBILE");
  await page.getByRole("button", { name: /Rose Mobile/ }).click();
  await page.getByRole("textbox", { name: "Menge in Karton" }).fill("10");
  await page.getByRole("button", { name: "In den Warenkorb" }).click();
  await page.getByRole("button", { name: "Warenkorb ansehen" }).click();
  await page.getByRole("button", { name: "Bestellung prüfen" }).click();
  await page.getByRole("heading", { name: "Bestellung prüfen", exact: true }).waitFor();
}

try {
  assert.equal((await fetch(api+"/__test/stock", {method:"POST"})).status, 204);
  await page.goto(web);
  await page.getByRole("heading", { name: "Anmelden", exact: true }).waitFor();
  assert.equal(await page.getByText("Demo", { exact: true }).count(), 0, "The export must use the real customer API.");
  await login("floraly@example.test");
  console.log("Pass: Browser PKCE and customer profile");
  let inducedExpiry = false;
  await page.route("**/v1/customer/quotes", async (route) => {
    if (inducedExpiry || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    inducedExpiry = true;
    await route.fulfill({
      status: 401,
      contentType: "application/problem+json",
      headers: { "Access-Control-Allow-Origin": web },
      body: JSON.stringify({ status: 401, code: "GH-AUTH-005" }),
    });
  });
  const refreshed = page.waitForResponse((reply) =>
    reply.url().endsWith("/v1/auth/oauth/token") &&
    reply.request().postDataJSON()?.grant_type === "refresh_token");

  await draft();
  assert.equal((await refreshed).status(), 200);
  await page.unroute("**/v1/customer/quotes");
  console.log("Pass: expired access token rotated through the worker");
  let capturedReference;
  const confirm = page.waitForResponse((reply) => /\/orders\/[^/]+\/confirm$/.test(reply.url()) && reply.request().method() === "POST");
  await page.getByRole("button", { name: "Verbindlich bestellen" }).click();
  const confirmed = await confirm;
  assert.equal(confirmed.status(), 200);
  capturedReference = (await confirmed.json()).id;
  await page.getByRole("heading", { name: "Bestellung bestätigt", exact: true }).waitFor();
  await page.getByRole("button", { name: "Bestellung ansehen" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Rechnung öffnen" }).click();
  assert.equal((await download).suggestedFilename(), `${capturedReference}.pdf`);
  console.log("Pass: customer checkout and actual invoice PDF");

  await page.getByRole("tab", { name: "Katalog" }).click();
  await draft();
  let recoveredReference;
  await page.route("**/orders/*/confirm", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const result = await route.fetch();
    assert.equal(result.status(), 200);
    recoveredReference = (await result.json()).id;
    await route.abort();
  });
  await page.getByRole("button", { name: "Verbindlich bestellen" }).click();
  await page.getByRole("heading", { name: "Bestellstatus", exact: true }).waitFor();
  await page.unroute("**/orders/*/confirm");
  await page.reload();
  await login("floraly@example.test", "Bestellstatus");
  await page.getByRole("button", { name: "Status prüfen", exact: true }).click();
  await page.getByText(`Deine Bestellnummer lautet ${recoveredReference}.`).waitFor();
  await page.getByRole("button", { name: "Bestellung ansehen", exact: true }).click();
  await page.getByRole("tab", { name: "Bestellungen", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(recoveredReference) }).waitFor();
  assert.notEqual(recoveredReference, capturedReference);
  assert.equal(await page.getByRole("button", { name: new RegExp(recoveredReference) }).count(), 1);
  assert.equal(await page.getByRole("button", { name: / · Bestätigt · / }).count(), 2);
  console.log("Pass: lost confirmed response across browser reload and login");

  await page.getByRole("tab", { name: "Konto", exact: true }).click();
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await page.getByRole("button", { name: "Jetzt abmelden", exact: true }).click();
  await login("blume@example.test");
  await page.getByRole("tab", { name: "Bestellungen", exact: true }).click();
  await page.getByText("Keine passenden Bestellungen.").waitFor();
  assert.equal(await page.getByRole("button", { name: new RegExp(capturedReference) }).count(), 0);
  console.log("Pass: customer separation after logout");
  assert.deepEqual(issues, []);
} finally {
  await browser.close();
}
