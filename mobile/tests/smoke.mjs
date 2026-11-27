import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
async function signIn(page, account) {
  await page.getByRole("button", {name:account, exact:true}).click();
  await page.getByRole("button", {name:"Code anfordern", exact:true}).click();
  await page.getByRole("textbox", {name:"Achtstelliger Code"}).fill("ABCD2345");
  await page.getByRole("button", {name:"Anmelden", exact:true}).click();
  await page.getByRole("heading", {name:"Katalog"}).waitFor();
}
async function putInCart(page) {
  await page.getByRole("textbox", {name:"Name oder Artikelnummer"}).fill("RO-RED");
  await page.getByRole("button", {name:/Rose Red Naomi/}).click();
  await page.getByText("Verfügbar: 24 · Einheit: Karton", {exact:true}).waitFor();
  await page.getByRole("textbox", {name:"Menge in Karton"}).fill("10");
  await page.getByRole("button", {name:"In den Warenkorb"}).click();
  await page.getByRole("button", {name:"Warenkorb ansehen"}).click();
  await page.getByRole("button", {name:"Bestellung prüfen"}).click();
}
try {
  for (const scenario of ["Normaler Einkauf","Preiswechsel","Bestandskonflikt","Antwortverlust"]) {
    const page = await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.PILOT_SMOKE_URL ?? "http://127.0.0.1:8081/");
    await signIn(page, "Floraly Berlin");
    if (scenario !== "Normaler Einkauf") {
      await page.getByRole("tab", {name:"Konto"}).click();
      await page.getByRole("button", {name:scenario}).click();
      await page.getByRole("tab", {name:"Katalog"}).click();
    }
    await putInCart(page);
    if (scenario === "Bestandskonflikt") {
      await page.getByRole("heading", {name:"Bestellung korrigieren"}).waitFor();
      assert.equal(await page.getByRole("button", {name:"Verbindlich bestellen"}).count(), 0);
      await page.getByRole("button", {name:"Warenkorb bearbeiten"}).click();
      await page.getByRole("button", {name:"Reservierung freigeben"}).click();
      await page.getByText("Rose Red Naomi", {exact:true}).waitFor();
    } else {
      if (scenario === "Preiswechsel") await page.getByText(/Der Auftrag hat sich geändert/).waitFor();
      await page.getByRole("button", {name:"Verbindlich bestellen"}).click();
      if (scenario === "Antwortverlust") {
        await page.getByRole("heading", {name:"Bestellstatus"}).waitFor();
        await page.reload();
        await page.getByRole("button", {name:"Status prüfen", exact:true}).click();
      }
      await page.getByRole("heading", {name:"Bestellung bestätigt"}).waitFor();
      await page.getByRole("button", {name:"Bestellung ansehen"}).click();
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", {name:"Rechnung öffnen"}).click();
      assert.match((await downloading).suggestedFilename(), /^GH-.*\.pdf$/);
      await page.getByRole("tab", {name:"Konto"}).click();
      await page.getByRole("button", {name:"Abmelden", exact:true}).click();
      await page.getByRole("button", {name:"Jetzt abmelden"}).click();
      await signIn(page, "Blume Amsterdam");
      await page.getByRole("tab", {name:"Bestellungen"}).click();
      await page.getByText("Keine passenden Bestellungen.").waitFor();
    }
    await page.close();
    console.log("Pass:", scenario);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
