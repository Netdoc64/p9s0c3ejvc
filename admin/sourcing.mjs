import { api } from "./api.mjs";
import { button, createPanel, el, label, select } from "./panel.mjs";

/** @typedef {{provider: string, connection: string, source_ref: string, sku: string, name: string, unit: string,
 * cost_cents: number, currency: string, available_quantity: number, minimum_quantity: number, expires_at: string | null}} Offer */
/** @typedef {{strategy: string, priority: string[], markup_pct: number, min_margin_cents: number, round_to_cents: number}} Rules */

const sourceNames = new Map([["floriday", "Floriday"], ["file-import", "Datei-Import"]]);
const sourceName = (/** @type {string} */ provider) => sourceNames.get(provider) ?? provider;
const source = (/** @type {{provider: string, connection: string}} */ item) => `${item.provider}:${item.connection}`;
const sourceLabel = (/** @type {string} */ key) => {
  const colon = key.indexOf(":");
  return colon < 0 ? sourceName(key) : `${sourceName(key.slice(0, colon))} · ${key.slice(colon + 1)}`;
};
const money = (/** @type {number} */ cents, /** @type {string} */ currency) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);

/** @param {string} title @param {string[]} columns @param {(string|HTMLElement)[][]} rows */
function table(title, columns, rows) {
  const wrapper = el("div");
  wrapper.className = "panel";
  const grid = el("table");
  grid.setAttribute("aria-label", title);
  const heading = grid.createTHead().insertRow();
  for (const column of columns) heading.append(el("th", column));
  const body = grid.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const item of row) tr.insertCell().append(item);
  }
  wrapper.append(grid);
  return wrapper;
}

/** @param {string} message */
function setupLink(message) {
  const text = el("p", message + " ");
  const link = el("a", "Module öffnen");
  link.href = "#module";
  text.append(link);
  return text;
}

async function offers() {
  /** @type {Offer[]} */
  const all = [];
  /** @type {string | null} */
  let after = null;
  do {
    /** @type {{items: Offer[], next_after: string | null}} */
    const page = await api("/v1/sourcing/offers?limit=200" + (after ? "&after=" + encodeURIComponent(after) : ""));
    all.push(...page.items);
    after = page.next_after;
  } while (after);
  return all;
}

/** @param {HTMLElement} main @param {boolean} owner @param {() => void} onExpired */
export function renderOffers(main, owner, onExpired) {
  const { content, run } = createPanel(main, onExpired);
  void run(async () => {
    const items = await offers();
    if (items.length === 0) {
      content.append(setupLink("Keine aktuellen Angebote verfügbar. Prüfe die Verbindung zu deinen Lieferanten."));
      return;
    }
    const filters = el("div");
    filters.className = "sourcing-filters";
    const query = el("input");
    query.type = "search";
    const sources = [...new Set(items.map(source))].sort();
    const provider = select([["", "Alle Quellen"], ...sources.map(key => /** @type {[string,string]} */ ([key, sourceLabel(key)]))]);
    const expires = el("input");
    expires.type = "date";
    filters.append(label("Suche", query), label("Quelle", provider), label("Gültig bis spätestens", expires));
    const list = el("div");
    /** @type {Set<Offer>} */
    const selected = new Set();
    const summary = el("p");
    summary.setAttribute("aria-live", "polite");
    const importButton = button("Ins Sortiment übernehmen");
    let importing = false;
    function updateSelection() {
      summary.textContent = `${selected.size} ausgewählt${selected.size > 200 ? " · Bitte auf höchstens 200 Angebote reduzieren." : ""}`;
      importButton.disabled = importing || selected.size === 0 || selected.size > 200;
    }
    function display() {
      const search = query.value.trim().toLocaleLowerCase("de");
      const visible = items.filter(item =>
        (!provider.value || source(item) === provider.value) &&
        (!search || `${item.name} ${item.sku}`.toLocaleLowerCase("de").includes(search)) &&
        (!expires.value || (item.expires_at !== null && item.expires_at.slice(0, 10) <= expires.value)),
      );
      if (!visible.length) {
        list.replaceChildren(el("p", "Keine passenden Angebote. Ändere die Filter."));
        return;
      }
      const rows = visible.map(item => {
        /** @type {(string | HTMLElement)[]} */
        const cells = [item.name, item.sku, sourceLabel(source(item)), `${money(item.cost_cents, item.currency)} / ${item.unit}`,
          String(item.available_quantity), String(item.minimum_quantity), item.expires_at?.slice(0, 10) ?? "Offen"];
        if (owner) {
          const check = el("input");
          check.type = "checkbox";
          check.checked = selected.has(item);
          check.setAttribute("aria-label", `${item.name} (${sourceLabel(source(item))}) auswählen`);
          check.addEventListener("change", () => {
            if (check.checked) selected.add(item);
            else selected.delete(item);
            updateSelection();
          });
          cells.unshift(check);
        }
        return cells;
      });
      const columns = ["Angebot", "SKU", "Quelle", "Einkaufspreis", "Verfügbar", "Mindestmenge", "Gültig bis"];
      if (owner) columns.unshift("Auswahl");
      list.replaceChildren(table("Angebote", columns, rows));
    }
    importButton.addEventListener("click", () => {
      importing = true;
      updateSelection();
      void run(async () => {
        const items = [...selected].map(({ provider, connection, source_ref }) => ({ provider, connection, source_ref }));
        /** @type {{created: string[], linked: string[], missing: string[]}} */
        const result = await api("/v1/sourcing/import", { method: "POST", body: { items } });
        selected.clear();
        display();
        const missing = result.missing.length ? ` ${result.missing.length} nicht mehr verfügbar. Prüfe die Angebote erneut.` : "";
        return `${result.created.length} Artikel angelegt, ${result.linked.length} mit Quellen verknüpft.${missing}`;
      }).finally(() => { importing = false; updateSelection(); });
    });
    for (const control of [query, provider, expires]) control.addEventListener("input", display);
    content.append(filters);
    if (owner) content.append(importButton, summary);
    content.append(list);
    display();
    updateSelection();
  });
}

const strategies = /** @type {Array<[string, string]>} */ ([["cheapest", "Günstigster Einkauf"], ["priority", "Reihenfolge der Quellen"], ["fastest", "Früheste Lieferung"]]);
const examples = [
  { name: "Beispiel Apfel", offers: [[210, "floriday", 2], [230, "file-import", 1]] },
  { name: "Beispiel Birne", offers: [[129, "floriday", 1], [125, "file-import", 2]] },
  { name: "Beispiel Pflaume", offers: [[185, "floriday", 2], [210, "file-import", 1]] },
];

/** @param {number} cost @param {Rules} rules */
export function sellPrice(cost, rules) {
  const markedUp = Math.ceil(cost * (1 + rules.markup_pct / 100));
  return Math.ceil(Math.max(markedUp, cost + rules.min_margin_cents) / rules.round_to_cents) * rules.round_to_cents;
}

/** @param {HTMLElement} main @param {boolean} owner @param {() => void} onExpired */
export function renderRules(main, owner, onExpired) {
  const { content, run } = createPanel(main, onExpired);
  void run(async () => {
    /** @type {Promise<Rules>} */
    const current = api("/v1/sourcing/rules");
    const [rules, items] = await Promise.all([current, offers()]);
    const priority = [...rules.priority];
    const form = el("form");
    form.className = "form rules-form";
    const strategy = select(strategies, rules.strategy);
    function number(/** @type {number} */ value, /** @type {number} */ min, /** @type {number} */ max, step = "1") {
      const input = el("input");
      Object.assign(input, { type: "number", value: String(value), min: String(min), max: String(max), step, required: true });
      return input;
    }
    const markup = number(rules.markup_pct, 0, 1000, "any");
    const margin = number(rules.min_margin_cents, 0, 1000000);
    const round = number(rules.round_to_cents, 1, 10000);
    const order = el("ol");
    const options = [...new Set([...sourceNames.keys(), ...items.map(source)])].sort();
    const sourcePicker = select(options.map(key => [key, sourceLabel(key)]));
    const add = button("Quelle hinzufügen");
    const save = el("button", "Preisregeln speichern");
    const preview = el("div");
    const fieldset = el("fieldset");
    fieldset.disabled = !owner;
    fieldset.append(el("legend", "Kalkulation"), label("Strategie", strategy), label("Aufschlag (%)", markup),
      label("Mindestmarge pro Einheit (Cent)", margin), label("Aufrunden auf (Cent)", round));
    const sourceFields = el("fieldset");
    sourceFields.disabled = !owner;
    sourceFields.append(el("legend", "Priorität der Quellen"), order);
    if (owner) sourceFields.append(label("Quelle", sourcePicker), add);
    form.append(fieldset, sourceFields);
    if (owner) form.append(save);
    content.append(form, el("h2", "Preisvorschau"), preview);

    function values() {
      return { strategy: strategy.value, priority: [...priority], markup_pct: markup.valueAsNumber,
        min_margin_cents: margin.valueAsNumber, round_to_cents: round.valueAsNumber };
    }

    function updatePreview() {
      const value = values();
      if (![markup, margin, round].every(input => input.validity.valid)) {
        preview.replaceChildren(el("p", "Bitte gib gültige Kalkulationswerte ein."));
        return;
      }
      const rank = (/** @type {string} */ provider) => {
        const connection = items.find(item => item.provider === provider);
        const exact = connection ? priority.indexOf(source(connection)) : -1;
        if (exact >= 0) return exact;
        const i = priority.indexOf(provider);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      const currency = items[0]?.currency ?? "EUR";
      const rows = examples.map(example => {
        const candidates = /** @type {[number, string, number][]} */ ([...example.offers]);
        const [cost, provider] = candidates.sort((a, b) => {
          if (value.strategy === "priority" && rank(a[1]) !== rank(b[1])) return rank(a[1]) - rank(b[1]);
          if (value.strategy === "fastest" && a[2] !== b[2]) return a[2] - b[2];
          return a[0] - b[0];
        })[0];
        return [example.name, sourceName(provider), money(cost, currency), money(sellPrice(cost, value), currency)];
      });
      preview.replaceChildren(table("Preisvorschau", ["Artikel", "Quelle", "Einkauf", "Verkauf"], rows));
    }

    function renderOrder() {
      order.replaceChildren();
      for (const [index, key] of priority.entries()) {
        const row = el("li", sourceLabel(key));
        if (owner) {
          const up = button("Nach oben");
          const down = button("Nach unten");
          const remove = button("Entfernen");
          up.disabled = index === 0;
          down.disabled = index === priority.length - 1;
          up.setAttribute("aria-label", `${sourceLabel(key)} nach oben`);
          down.setAttribute("aria-label", `${sourceLabel(key)} nach unten`);
          remove.setAttribute("aria-label", `${sourceLabel(key)} aus Priorität entfernen`);
          up.addEventListener("click", () => move(index, index - 1, "up"));
          down.addEventListener("click", () => move(index, index + 1, "down"));
          remove.addEventListener("click", () => { priority.splice(index, 1); renderOrder(); sourcePicker.focus(); });
          row.append(up, down, remove);
          row.draggable = true;
          row.addEventListener("dragstart", event => event.dataTransfer?.setData("text/plain", String(index)));
          row.addEventListener("dragover", event => event.preventDefault());
          row.addEventListener("drop", event => {
            event.preventDefault();
            const from = event.dataTransfer?.getData("text/plain");
            if (from && /^\d+$/.test(from) && Number(from) < priority.length) move(Number(from), index);
          });
        }
        order.append(row);
      }
      if (!priority.length) order.append(el("li", "Keine Quellen priorisiert"));
      add.disabled = priority.length >= 20 || priority.includes(sourcePicker.value);
      updatePreview();
    }
    function move(/** @type {number} */ from, /** @type {number} */ to, direction = "") {
      priority.splice(to, 0, priority.splice(from, 1)[0]);
      renderOrder();
      const buttons = order.children[to]?.querySelectorAll("button");
      const next = buttons?.[direction === "down" ? 1 : 0];
      if (direction && next) (next.disabled ? buttons?.[direction === "down" ? 0 : 1] : next)?.focus();
    }
    add.addEventListener("click", () => {
      priority.push(sourcePicker.value);
      renderOrder();
      sourcePicker.focus();
    });
    sourcePicker.addEventListener("change", () => {
      add.disabled = priority.length >= 20 || priority.includes(sourcePicker.value);
    });
    form.addEventListener("input", updatePreview);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!owner) return;
      void run(async () => {
        await api("/v1/sourcing/rules", { method: "PUT", body: values() });
        return "Preisregeln gespeichert und Sortimentskalkulation aktualisiert.";
      }, save);
    });
    renderOrder();
  });
}

const purchaseStatuses = new Map([
  ["open", "Offen"], ["sent", "Gesendet"], ["cancelled", "Storniert"],
  ["cancel_requested", "Storno angefragt"], ["failed", "Fehlgeschlagen"],
]);
const purchaseErrors = new Map([
  ["GH-SUPPLIER-001", "Verbindung fehlt. Prüfe die Einrichtung des Lieferanten."],
  ["GH-SUPPLIER-002", "Das Angebot ist nicht mehr verfügbar. Stimme einen Ersatz mit dem Lieferanten ab."],
  ["GH-SUPPLIER-003", "Die Anforderung konnte in diesem Status nicht verarbeitet werden. Prüfe ihren Status beim Lieferanten."],
  ["GH-INPUT-001", "Angaben sind unvollständig. Prüfe die Lieferdaten."],
]);

/** @typedef {{order_id: string, sku_id: string, sku_name: string | null, provider: string, connection: string, source_qty: number, status: string, note: string | null}} Purchase */

/** @param {HTMLElement} main @param {() => void} onExpired */
export function renderPurchases(main, onExpired) {
  const { content, run } = createPanel(main, onExpired);
  void run(async () => {
    /** @type {{items: Purchase[]}} */
    const { items } = await api("/v1/purchase-orders");
    if (!items.length) {
      content.append(el("p", "Noch keine Einkaufsbestellungen. Sie entstehen, sobald Kunden Lieferantenartikel bestellen und bestätigen."));
      return;
    }
    const sources = [...new Set(items.map(source))].sort();
    const filter = select([["", "Alle Quellen"], ...sources.map(key => /** @type {[string,string]} */ ([key, sourceLabel(key)]))]);
    const rows = el("div");
    content.append(label("Quelle", filter), rows);
    function display() {
      const visible = items.filter(item => !filter.value || source(item) === filter.value);
      rows.replaceChildren(table("Einkaufsbestellungen", ["Kundenbestellung", "Artikel", "Quelle", "Menge", "Status", "Nächster Schritt"],
        visible.map(item => {
          const error = purchaseErrors.get(item.note?.match(/^GH-[A-Z]+-\d+/)?.[0] ?? "");
          const next = error ?? (item.status === "failed" || item.note === "Senden fehlgeschlagen"
            ? "Übermittlung fehlgeschlagen. Prüfe die Verbindung und den Status beim Lieferanten."
            : item.status === "cancel_requested" ? "Storno beim Lieferanten prüfen."
            : item.status === "open" ? "Übermittlung mit dem Einkauf abstimmen." : "–");
          return [item.order_id, item.sku_name ?? item.sku_id, sourceLabel(source(item)),
            String(item.source_qty), purchaseStatuses.get(item.status) ?? "Unbekannt", next];
        }),
      ));
    }
    filter.addEventListener("change", display);
    display();
  });
}
