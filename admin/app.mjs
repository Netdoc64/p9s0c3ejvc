import { loadDashboard } from "./data.mjs";

import { activeToken, ApiError, endSession, getProfile, live } from "./api.mjs";
import { errorMessage, showLogin } from "./login.mjs";
const money = (/** @type {number} */ cents, /** @type {string} */ currency) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
/** @param {Awaited<ReturnType<typeof loadDashboard>>} data */
function buildSections(data) {
  const products = new Map(data.products.items.map(p => [p.id, p.name]));
  const customers = new Map(data.customers.items.map(c => [c.id, c.name]));
  return [
    { id: "produkte", title: "Produkte", columns: ["Artikel", "SKU", "Stückpreis"],
      rows: data.products.items.map(p => {
        const price = data.prices.get(p.id);
        return [p.name, p.sku_code, price ? money(price.unit_price_cents, price.currency) : live ? "Kundenabhängig" : "Preis fehlt"];
      }) },
    { id: "bestand", title: "Bestand", columns: ["Artikel", "Lager", "Verfügbar", "Reserviert"],
      rows: data.inventory.map(i => [products.get(i.sku_id) ?? i.sku_id, i.warehouse_id, i.state.available, i.state.reserved]) },
    { id: "kunden", title: "Kunden", columns: ["Kunde", "E-Mail", "Land"],
      rows: data.customers.items.map(c => [c.name, c.email, c.country]) },
    { id: "bestellungen", title: "Bestellungen", columns: ["Bestellung", "Kunde", "Status", "Gesamt"],
      rows: data.orders.items.map(o => [o.id, customers.get(o.customer_id) ?? o.customer_id, o.state, money(o.total_cents, o.currency)]) },
    { id: "retouren", title: "Retouren", columns: ["Fall", "Bestellung", "Art", "Positionen"],
      rows: data.returns.items.map(r => [r.id, r.order_id, r.kind === "return" ? "Retoure" : "Reklamation", r.lines?.length ?? 0]) },
  ];
}

function element(/** @type {string} */ tag, value = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
const overview = { id: "uebersicht", title: "Übersicht" };
const nav = document.querySelector("nav");
const main = document.querySelector("main");
if (!nav || !main) throw new Error("Dashboard-Layout fehlt");
const identity = document.querySelector("#identity");
const signOut = document.querySelector("#sign-out");
if (!(identity instanceof HTMLElement) || !(signOut instanceof HTMLButtonElement)) throw new Error("Dashboard-Kopf fehlt");

/** @type {ReturnType<typeof buildSections>} */
let sections = [];
/** @type {import("./api.mjs").StaffProfile | null} */
let profile = null;
let ready = false;
function renderNav() {
  if (!nav) return;
  nav.replaceChildren();
  for (const section of [overview, ...sections]) {
    const link = document.createElement("a");
    link.href = "#" + section.id;
    link.textContent = section.title;
    nav.append(link);
  }
}
function render() {
  if (!main || !nav || !ready) return;
  const section = sections.find(s => s.id === location.hash.slice(1));
  const current = section ?? overview;
  document.title = current.title + " · Händler-Dashboard";
  for (const link of nav.querySelectorAll("a")) {
    if (link.hash === "#" + current.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  main.replaceChildren(element("h1", current.title));
  if (!section) {
    const cards = element("div");
    cards.className = "cards";
    for (const s of sections) {
      const link = document.createElement("a");
      link.href = "#" + s.id;
      link.append(element("strong", String(s.rows.length)), element("span", s.title));
      cards.append(link);
    }
    main.append(cards);
    return;
  }
  if (section.rows.length === 0) {
    main.append(element("p", `Keine Einträge für „${section.title}“ vorhanden.`));
    return;
  }
  const table = document.createElement("table");
  table.setAttribute("aria-label", section.title);
  const head = table.createTHead().insertRow();
  for (const label of section.columns) head.append(element("th", label));
  const body = table.createTBody();
  for (const values of section.rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = String(value);
  }
  const panel = element("div");
  panel.className = "panel";
  panel.append(table);
  main.append(panel);
}
window.addEventListener("hashchange", render);
signOut.addEventListener("click", () => {
  endSession();
  renderLogin("Du bist abgemeldet.");
});

function renderLogin(message = "") {
  if (!nav || !identity || !(signOut instanceof HTMLButtonElement)) return;
  ready = false;
  profile = null;
  sections = [];
  nav.replaceChildren();
  identity.textContent = "";
  signOut.hidden = true;
  document.title = "Anmelden · Händler-Dashboard";
  showLogin(showDashboard, message);
}

async function showDashboard() {
  if (!main || !identity || !(signOut instanceof HTMLButtonElement)) return;
  ready = false;
  main.replaceChildren(element("h1", "Dashboard wird geladen"));
  try {
    if (live) profile = await getProfile();
    sections = buildSections(await loadDashboard());
    identity.textContent = profile?.email ?? "Demo-Betrieb";
    signOut.hidden = !live;
    renderNav();
    ready = true;
    render();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      renderLogin(cause.message);
      return;
    }
    const retry = document.createElement("button");
    retry.textContent = "Erneut laden";
    retry.addEventListener("click", () => void showDashboard());
    const message = element("p", errorMessage(cause));
    message.setAttribute("role", "alert");
    signOut.hidden = !live;
    main.replaceChildren(element("h1", "Dashboard konnte nicht geladen werden"), message, retry);
  }
}

if (live && !activeToken()) renderLogin();
else await showDashboard();
