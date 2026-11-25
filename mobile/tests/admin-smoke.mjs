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
} finally {
  await browser.close();
}
