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
  let role = "staff";
  const members = [{ id: "staff_demo", email: "team@handel.example", role: "owner", disabled_at: null }];
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
    if (url.pathname === "/v1/staff/me") return ok({ id: "staff_demo", email: "team@handel.example", role });
    if (url.pathname === "/v1/staff") {
      assert.equal(role, "owner");
      if (request.method() === "POST") {
        const { email, role } = request.postDataJSON();
        if (members.some(member => member.email === email)) return route.fulfill({ status: 409, json: { code: "GH-STAFF-001" } });
        members.push({ id: "staff_new", email, role, disabled_at: null });
      }
      return ok({ data: members });
    }
    if (url.pathname === "/v1/staff/staff_new" && request.method() === "DELETE") {
      members.at(-1).disabled_at = "2026-01-01";
      return route.fulfill({ status: 204 });
    }
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
  assert.equal(await livePage.getByRole("link", { name: "Team" }).count(), 0);
  await livePage.evaluate(() => { location.hash = "team"; });
  await livePage.getByRole("heading", { name: "Übersicht" }).waitFor();
  role = "owner";
  await livePage.reload();
  await livePage.getByRole("heading", { name: "Team" }).waitFor();
  await livePage.getByText("Eigenes Konto").waitFor();
  await livePage.getByLabel("E-Mail-Adresse").fill("team@handel.example");
  await livePage.getByRole("button", { name: "Einladen" }).click();
  await livePage.getByText("Diese E-Mail-Adresse ist bereits im Team eingetragen.").waitFor();
  await livePage.getByLabel("E-Mail-Adresse").fill("neu@handel.example");
  await livePage.getByRole("button", { name: "Einladen" }).click();
  await livePage.getByText("neu@handel.example kann jetzt einen Anmeldecode anfordern.").waitFor();
  livePage.once("dialog", async dialog => {
    assert.match(dialog.message(), /neu \(neu@handel\.example\)/);
    await dialog.accept();
  });
  await livePage.getByRole("button", { name: "neu@handel.example sperren" }).click();
  await livePage.getByRole("row", { name: /neu@handel.example/ }).getByText("Gesperrt").waitFor();
  expired = true;
  await livePage.reload();
  await livePage.getByRole("heading", { name: "Anmelden" }).waitFor();
  assert.equal(await livePage.evaluate(() => sessionStorage.getItem("grosshandel-admin-session")), null);
} finally {
  await browser.close();
}
