import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.ADMIN_SMOKE_URL ?? "http://127.0.0.1:8082/");
  await page.getByRole("heading", { name: "Übersicht" }).waitFor();
  for (const [section, sample] of [
    ["Produkte", "16,00"], ["Bestand", "wh_demo"], ["Kunden", "einkauf@handel.example"],
    ["Bestellungen", "48,00"], ["Retouren", "ret_demo"],
  ]) {
    await page.getByRole("navigation").getByRole("link", { name: section }).click();
    const table = page.getByRole("table", { name: section });
    await table.waitFor();
    assert.ok((await table.innerText()).includes(sample));
    await page.reload();
    await page.getByRole("heading", { name: section }).waitFor();
  }
  assert.deepEqual(errors, []);

  const livePage = await browser.newPage();
  let signedIn = false;
  let expired = false;
  await livePage.route("**/config.mjs", route => route.fulfill({
    contentType: "application/javascript",
    body: `export const config = {apiUrl: ${JSON.stringify(new URL(route.request().url()).origin)}, tenant: "demo"};`,
  }));
  await livePage.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    const ok = json => route.fulfill({ json });
    if (url.pathname.startsWith("/v1/auth/")) assert.equal(headers["x-tenant-slug"], "demo");
    if (url.pathname.endsWith("/code/request")) return ok({ ok: true });
    if (url.pathname.endsWith("/code/verify")) {
      if (request.postDataJSON().code !== "ABCDEFGH") return route.fulfill({ status: 410, json: { code: "GH-AUTH-006", detail: "intern" } });
      signedIn = true;
      return ok({ access_token: "test-token", expires_in: 60 });
    }
    assert.equal(signedIn, true);
    assert.equal(headers.authorization, "Bearer test-token");
    if (expired) return route.fulfill({ status: 401 });
    if (url.pathname === "/v1/staff/me") return ok({ id: "staff_demo", email: "team@handel.example", role: "staff" });
    if (url.pathname === "/v1/stock/overview") {
      return ok(url.searchParams.has("cursor")
        ? { items: [{ sku_id: "sku_demo", warehouse_id: "wh_second", available: 4, reserved: 1 }], next_cursor: null }
        : { items: [], next_cursor: "stock-next" });
    }
    return ok({ items: [], next_cursor: null });
  });
  await livePage.goto(process.env.ADMIN_SMOKE_URL ?? "http://127.0.0.1:8082/");
  await livePage.getByRole("heading", { name: "Anmelden" }).waitFor();
  await livePage.getByLabel("E-Mail-Adresse").fill("team@handel.example");
  await livePage.getByRole("button", { name: "Code anfordern" }).click();
  await livePage.getByLabel("Anmeldecode").fill("22222222");
  await livePage.getByRole("button", { name: "Anmelden" }).click();
  await livePage.getByText("Der Code ist falsch oder abgelaufen.", { exact: false }).waitFor();
  await livePage.getByLabel("Anmeldecode").fill("abcdefgh");
  await livePage.getByRole("button", { name: "Anmelden" }).click();
  await livePage.getByRole("heading", { name: "Übersicht" }).waitFor();
  await livePage.getByRole("navigation").getByRole("link", { name: "Bestand" }).click();
  await livePage.getByText("wh_second").waitFor();
  await livePage.reload();
  await livePage.getByText("wh_second").waitFor();
  assert.equal(await livePage.evaluate(() => JSON.stringify(localStorage).includes("test-token")), false);
  expired = true;
  await livePage.reload();
  await livePage.getByRole("heading", { name: "Anmelden" }).waitFor();
  assert.equal(await livePage.evaluate(() => sessionStorage.getItem("grosshandel-admin-session")), null);
} finally {
  await browser.close();
}
