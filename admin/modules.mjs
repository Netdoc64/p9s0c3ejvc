import { api } from "./api.mjs";
import { button, createPanel, el, label, select } from "./panel.mjs";

/** @typedef {{name: string, label: string, type: "text"|"secret"|"select"|"boolean"|"number", required: boolean, options?: string[], help?: string}} Field */
/** @typedef {{id: string, name: string, description: string, available: boolean, enabled: boolean, configured: boolean,
 * status: "ok"|"error"|"unchecked", settings?: Record<string, string | number | boolean>, fields: Field[],
 * credentials?: {configured: boolean, fingerprint?: string}, checkable?: boolean}} Module */

const statuses = { ok: "Verbindung in Ordnung", error: "Verbindung fehlgeschlagen", unchecked: "Ungeprüft" };

/** @param {Module} module @param {Field} field */
function fieldInput(module, field) {
  const value = module.settings?.[field.name];
  if (field.type === "select") return select([["", "Bitte wählen"], ...(field.options ?? []).map(option => /** @type {[string, string]} */ ([option, option]))], String(value ?? ""));
  const input = el("input");
  input.type = { secret: "password", boolean: "checkbox", select: "text", number: "number", text: "text" }[field.type];
  if (field.type === "secret") {
    input.autocomplete = "new-password";
    input.maxLength = 4096;
  } else if (field.type === "boolean") {
    input.checked = value === true;
  } else {
    input.value = String(value ?? "");
  }
  return input;
}

/** @param {HTMLElement} main @param {boolean} owner @param {() => void} onExpired */
export function renderModules(main, owner, onExpired) {
  const { content, run } = createPanel(main, onExpired);
  async function load() {
    /** @type {{data: Module[]}} */
    const { data } = await api("/v1/modules");
    content.replaceChildren();
    if (!data.length) content.append(el("p", "Keine Module verfügbar. Bitte wende dich an den Support."));
    for (const module of data) renderModule(module);
  }

  /** @param {Module} module */
  function renderModule(module) {
    const section = el("section");
    section.className = "sourcing-card";
    section.append(el("h2", module.name), el("p", module.description));
    section.append(el("p", `${module.available ? module.enabled ? "Ein" : "Aus" : "Nicht verfügbar"} · ${statuses[module.status]}`));
    if (module.credentials?.configured) {
      const fingerprint = module.credentials.fingerprint;
      section.append(el("p", fingerprint ? `Zugang hinterlegt (Abdruck ${fingerprint})` : "Zugang hinterlegt"));
    }
    content.append(section);
    if (!owner || !module.available) return;

    const path = "/v1/modules/" + encodeURIComponent(module.id);
    const toggle = button(module.enabled ? "Ausschalten" : "Einschalten");
    toggle.disabled = !module.configured && !module.enabled;
    toggle.addEventListener("click", () => void run(async () => {
      await api(path, { method: "PUT", body: { enabled: !module.enabled } });
      await load();
      return `${module.name} wurde ${module.enabled ? "ausgeschaltet" : "eingeschaltet"}.`;
    }, toggle));
    section.append(toggle);

    const setup = el("details");
    setup.append(el("summary", module.credentials?.configured ? "Einrichten und Zugang ersetzen" : "Einrichten"));
    const form = el("form");
    form.className = "form";
    form.autocomplete = "off";
    const fields = module.fields.map(field => {
      const input = fieldInput(module, field);
      input.required = field.required && !(field.type === "secret" && module.credentials?.configured);
      const wrapper = label(field.label, input);
      if (field.help) wrapper.append(el("small", field.help));
      form.append(wrapper);
      return { field, input };
    });

    async function check() {
      /** @type {{status: Module["status"]}} */
      const result = await api(path + "/check", { method: "POST" });
      await load();
      const detail = {
        ok: "Die Verbindung funktioniert.",
        error: "Prüfe die Angaben und den Zugang beim Anbieter. Starte dann die Verbindungsprüfung erneut.",
        unchecked: "Für dieses Modul ist keine automatische Verbindungsprüfung verfügbar.",
      };
      return `${module.name}: ${detail[result.status]}`;
    }

    const save = el("button", "Speichern und Verbindung prüfen");
    form.append(save);
    form.addEventListener("submit", event => {
      event.preventDefault();
      void run(async () => {
        /** @type {Record<string, string>} */
        const credentials = {};
        /** @type {Record<string, string | number | boolean>} */
        const settings = {};
        for (const { field, input } of fields) {
          if (field.type === "secret") {
            if (input.value) credentials[field.name] = input.value;
            input.value = "";
          } else if (input instanceof HTMLInputElement && field.type === "boolean") {
            settings[field.name] = input.checked;
          } else if (input instanceof HTMLInputElement && field.type === "number") {
            if (input.value) settings[field.name] = input.valueAsNumber;
          } else {
            settings[field.name] = input.value;
          }
        }
        if (Object.keys(credentials).length) await api(path + "/credentials", { method: "PUT", body: credentials });
        await api(path, { method: "PUT", body: { enabled: module.enabled, settings } });
        return check();
      }, save);
    });
    setup.append(form);
    section.append(setup);

    if (module.configured && module.checkable !== false) {
      const verify = button("Verbindung prüfen");
      verify.addEventListener("click", () => void run(check, verify));
      section.append(verify);
    }
    if (module.credentials?.configured) {
      const remove = button("Zugang entfernen");
      remove.addEventListener("click", () => {
        if (!window.confirm(`Zugang für ${module.name} entfernen und Modul ausschalten?`)) return;
        void run(async () => {
          await api(path + "/credentials", { method: "DELETE" });
          await load();
          return "Zugang entfernt. Das Modul ist ausgeschaltet.";
        }, remove);
      });
      section.append(remove);
    }
  }
  void run(load);
}
