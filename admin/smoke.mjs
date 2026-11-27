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
  const modulePath = "/v1/modules/floriday";
  const module = {
    id: "floriday", name: "Floriday", description: "Angebote synchronisieren", available: true,
    enabled: false, configured: false, status: "unchecked", credentials: { configured: false },
    fields: [
      { name: "account", label: "Käuferkonto", type: "text", required: true },
      { name: "apiKey", label: "API-Schlüssel", type: "secret", required: true },
    ],
  };
  const offers = [
    { provider: "floriday", connection: "demo", source_ref: "offer_1", name: "Apfelkiste", sku: "AP-1", expires_at: "2099-01-01T23:59:00Z" },
    { provider: "file-import", connection: "demo", source_ref: "offer_2", name: "Birnenkiste", sku: "BI-1", expires_at: "2099-02-01T23:59:00Z" },
  ].map(item => ({ ...item, unit: "Kiste", cost_cents: 235, currency: "EUR", available_quantity: 20, minimum_quantity: 2 }));
  const rules = { strategy: "priority", priority: ["floriday", "file-import"], markup_pct: 30, min_margin_cents: 0, round_to_cents: 1 };
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
    if (url.pathname === "/v1/modules") return ok({ data: [module] });
    if (url.pathname === modulePath + "/credentials") {
      assert.equal(role, "owner");
      assert.deepEqual(request.postDataJSON(), { apiKey: "nur-synthetisch" });
      module.credentials = { configured: true, fingerprint: "demo-fp" };
      module.configured = true;
      return ok(module.credentials);
    }
    if (url.pathname === modulePath) {
      assert.equal(role, "owner");
      const { enabled, settings } = request.postDataJSON();
      if (settings) assert.deepEqual(settings, { account: "demo" });
      module.enabled = enabled;
      return ok(module);
    }
    if (url.pathname === modulePath + "/check") {
      module.status = "ok";
      return ok({ status: "ok", detail: "internes Prüfergebnis" });
    }
    if (url.pathname === "/v1/sourcing/offers") return ok({ items: offers, next_after: null });
    if (url.pathname === "/v1/sourcing/import") {
      assert.equal(role, "owner");
      assert.deepEqual(request.postDataJSON().items, offers.map(({ provider, source_ref, connection }) => ({ provider, source_ref, connection })));
      return ok({ created: ["sku_1", "sku_2"], linked: ["sku_1", "sku_2"], missing: [] });
    }
    if (url.pathname === "/v1/sourcing/rules") {
      if (request.method() === "PUT") {
        assert.equal(role, "owner");
        const values = request.postDataJSON();
        assert.deepEqual(values.priority, ["file-import", "floriday"]);
        assert.equal(values.round_to_cents, 10);
        Object.assign(rules, values);
      }
      return ok(rules);
    }
    if (url.pathname === "/v1/purchase-orders") {
      return ok({ items: [{ order_id: "ord_demo", sku_name: "Apfelkiste", provider: "floriday", connection: "demo",
        source_qty: 4, status: "failed", note: "GH-SUPPLIER-002 interner Text" }] });
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
  await livePage.getByRole("link", { name: "Module", exact: true }).click();
  await livePage.getByRole("heading", { name: "Floriday" }).waitFor();
  assert.equal(await livePage.getByText("Einrichten", { exact: true }).count(), 0);
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
  await livePage.getByRole("link", { name: "Module", exact: true }).click();
  await livePage.getByText("Einrichten", { exact: true }).click();
  await livePage.getByLabel("Käuferkonto").fill("demo");
  const secret = livePage.getByLabel("API-Schlüssel");
  assert.equal(await secret.getAttribute("type"), "password");
  await secret.fill("nur-synthetisch");
  await livePage.getByRole("button", { name: "Speichern und Verbindung prüfen" }).click();
  await livePage.getByText("Zugang hinterlegt (Abdruck demo-fp)").waitFor();
  await livePage.getByText("Floriday: Die Verbindung funktioniert.").waitFor();
  assert.equal(await livePage.evaluate(() => (JSON.stringify(sessionStorage) + JSON.stringify(localStorage) + document.body.innerHTML).includes("nur-synthetisch")), false);
  await livePage.getByRole("button", { name: "Einschalten" }).click();
  await livePage.getByText("Floriday wurde eingeschaltet.").waitFor();

  await livePage.getByRole("link", { name: "Angebote", exact: true }).click();
  await livePage.getByRole("table", { name: "Angebote" }).waitFor();
  await livePage.getByLabel("Quelle").selectOption("floriday:demo");
  assert.equal(await livePage.getByText("Birnenkiste", { exact: true }).count(), 0);
  await livePage.getByLabel("Suche").fill("fehlt");
  await livePage.getByText("Keine passenden Angebote.", { exact: false }).waitFor();
  await livePage.getByLabel("Suche").fill("");
  await livePage.getByLabel("Quelle").selectOption("");
  await livePage.getByLabel("Gültig bis spätestens").fill("2099-01-02");
  assert.equal(await livePage.getByText("Birnenkiste", { exact: true }).count(), 0);
  await livePage.getByLabel("Gültig bis spätestens").fill("");
  await livePage.getByRole("checkbox", { name: /^Apfelkiste/ }).check();
  await livePage.getByRole("checkbox", { name: /^Birnenkiste/ }).check();
  await livePage.getByRole("button", { name: "Ins Sortiment übernehmen" }).click();
  await livePage.getByText("2 Artikel angelegt, 2 mit Quellen verknüpft.").waitFor();

  await livePage.getByRole("link", { name: "Preisregeln", exact: true }).click();
  const preview = livePage.getByRole("table", { name: "Preisvorschau" });
  await preview.waitFor();
  assert.equal(await preview.getByRole("row").count(), 4);
  await livePage.getByRole("button", { name: "Datei-Import nach oben" }).press("Enter");
  await livePage.getByLabel("Aufrunden auf (Cent)").fill("10");
  await preview.getByRole("row", { name: /Beispiel Apfel.*3,00/ }).waitFor();
  await livePage.getByRole("button", { name: "Preisregeln speichern" }).click();
  await livePage.getByText("Preisregeln gespeichert", { exact: false }).waitFor();

  await livePage.getByRole("link", { name: "Einkauf", exact: true }).click();
  await livePage.getByText("Fehlgeschlagen", { exact: true }).waitFor();
  await livePage.getByText("Das Angebot ist nicht mehr verfügbar.", { exact: false }).waitFor();
  assert.equal(await livePage.getByText("interner Text", { exact: false }).count(), 0);
  expired = true;
  await livePage.reload();
  await livePage.getByRole("heading", { name: "Anmelden" }).waitFor();
  assert.equal(await livePage.evaluate(() => sessionStorage.getItem("grosshandel-admin-session")), null);
} finally {
  await browser.close();
}
