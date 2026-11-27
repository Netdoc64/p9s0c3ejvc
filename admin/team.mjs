import { api, ApiError } from "./api.mjs";
import { errorMessage } from "./login.mjs";

/** @typedef {import("./api.mjs").StaffProfile & {disabled_at: string | null, name?: string}} StaffMember */

/** @param {HTMLElement} main @param {import("./api.mjs").StaffProfile} profile @param {() => void} onExpired */
export function renderTeam(main, profile, onExpired) {
  const template = document.querySelector("#team-template");
  if (!(template instanceof HTMLTemplateElement)) return;
  main.append(template.content.cloneNode(true));
  const form = main.querySelector("form");
  const members = main.querySelector("tbody");
  const feedback = main.querySelector('[role="status"]');
  if (!form || !members || !feedback) return;

  /** @param {unknown} cause */
  function showFailure(cause) {
    if (!feedback) return;
    if (cause instanceof ApiError) {
      if (cause.status === 401) return onExpired();
      if (cause.code === "GH-STAFF-001") {
        feedback.textContent = "Diese E-Mail-Adresse ist bereits im Team eingetragen.";
        return;
      }
      if (cause.code === "GH-STAFF-002") {
        feedback.textContent = "Du kannst dein eigenes Konto nicht sperren.";
        return;
      }
    }
    feedback.textContent = errorMessage(cause);
  }

  async function refresh() {
    if (!members) return;
    /** @type {{data: StaffMember[]}} */
    const result = await api("/v1/staff");
    members.replaceChildren();
    if (result.data.length === 0) {
      const cell = members.insertRow().insertCell();
      cell.colSpan = 4;
      cell.textContent = "Noch keine Einträge. Lade ein Teammitglied über das Formular ein.";
      return;
    }
    for (const member of result.data) {
      const row = members.insertRow();
      row.insertCell().textContent = member.email;
      row.insertCell().textContent = member.role === "owner" ? "Inhaber" : "Mitarbeiter";
      row.insertCell().textContent = member.disabled_at ? "Gesperrt" : "Aktiv";
      const action = row.insertCell();
      if (member.disabled_at) continue;
      const block = document.createElement("button");
      block.type = "button";
      block.textContent = "Sperren";
      block.setAttribute("aria-label", `${member.email} sperren`);
      block.disabled = member.id === profile.id;
      if (block.disabled) action.append("Eigenes Konto");
      else action.append(block);
      block.addEventListener("click", () => {
        const name = member.name ?? member.email.split("@")[0];
        if (!window.confirm(`${name} (${member.email}) wirklich sperren?`)) return;
        void run(block, async () => {
          await api("/v1/staff/" + encodeURIComponent(member.id), { method: "DELETE" });
          return `${member.email} wurde gesperrt.`;
        });
      });
    }
  }

  /** @param {HTMLButtonElement} button @param {() => Promise<string>} action */
  async function run(button, action) {
    if (!feedback) return;
    button.disabled = true;
    feedback.textContent = "";
    try {
      feedback.textContent = await action();
      await refresh();
    } catch (cause) {
      showFailure(cause);
    } finally {
      button.disabled = false;
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!(event.submitter instanceof HTMLButtonElement)) return;
    const fields = new FormData(form);
    void run(event.submitter, async () => {
      const email = String(fields.get("email") ?? "").trim();
      await api("/v1/staff", { method: "POST", body: { email, role: fields.get("role") } });
      form.reset();
      return `${email} kann jetzt einen Anmeldecode anfordern.`;
    });
  });
  if (feedback) feedback.textContent = "Team wird geladen …";
  void refresh().then(() => { if (feedback) feedback.textContent = ""; }, showFailure);
}
