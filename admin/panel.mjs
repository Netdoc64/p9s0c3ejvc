import { ApiError } from "./api.mjs";
import { errorMessage } from "./login.mjs";

/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] */
export function el(tag, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/** @param {string} text */
export function button(text) {
  const control = el("button", text);
  control.type = "button";
  return control;
}

/** @param {string} caption @param {HTMLElement} control */
export function label(caption, control) {
  const field = el("label", caption);
  field.append(control);
  return field;
}

/** @param {Array<[string, string]>} options @param {string} [value] */
export function select(options, value = "") {
  const control = el("select");
  for (const [key, title] of options) {
    const option = el("option", title);
    option.value = key;
    control.append(option);
  }
  if (value) control.value = value;
  return control;
}

const errors = new Map([
  ["GH-MODULE-001", "Das Modul ist für diesen Betrieb nicht verfügbar."],
  ["GH-MODULE-002", "Zugangsdaten können derzeit nicht gespeichert werden. Bitte wende dich an den Support."],
  ["GH-MODULE-003", "Der gespeicherte Zugang ist nicht lesbar. Bitte ersetze die Zugangsdaten."],
  ["GH-MODULE-004", "Bitte prüfe die Pflichtfelder und Zugangsdaten des Moduls."],
  ["GH-PROD-001", "Der Artikel ist nicht mehr verfügbar. Lade die Seite neu."],
  ["GH-SUPPLIER-001", "Die Verbindung zur Quelle fehlt. Prüfe die Einrichtung unter Module."],
  ["GH-SUPPLIER-002", "Der Eintrag oder das Angebot ist nicht mehr verfügbar."],
  ["GH-SUPPLIER-003", "Der Vorgang ist in seinem aktuellen Status nicht möglich."],
]);

/** @param {HTMLElement} main @param {() => void} onExpired */
export function createPanel(main, onExpired) {
  const content = el("div");
  content.className = "sourcing-content";
  const feedback = el("p", "Wird geladen …");
  feedback.setAttribute("role", "status");
  main.append(feedback, content);
  return {
    content,
    /** @param {() => Promise<string | void>} action @param {HTMLButtonElement} [control] */
    async run(action, control) {
      if (control) control.disabled = true;
      feedback.textContent = "Wird verarbeitet …";
      try {
        feedback.textContent = (await action()) ?? "";
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401 && content.isConnected) return onExpired();
        feedback.textContent = (cause instanceof ApiError && errors.get(cause.code)) || errorMessage(cause);
      } finally {
        if (control) control.disabled = false;
      }
    },
  };
}
