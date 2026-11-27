import { ApiError, requestCode, signIn } from "./api.mjs";

/** @param {unknown} cause */
export function errorMessage(cause) {
  return cause instanceof ApiError ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.";
}

/** @param {() => Promise<void>} onSuccess @param {string} message */
export function showLogin(onSuccess, message) {
  const template = document.querySelector("#login-template");
  const main = document.querySelector("main");
  if (!(template instanceof HTMLTemplateElement) || !main) return;
  main.replaceChildren(template.content.cloneNode(true));
  const form = main.querySelector("form");
  const email = form?.querySelector("input[type=email]");
  const code = form?.querySelector("input[name=code]");
  const codeLabel = code?.closest("label");
  const submit = form?.querySelector("button[type=submit]");
  const resend = form?.querySelector("button[type=button]");
  const feedback = form?.querySelector('[role="status"]');
  if (!form || !(email instanceof HTMLInputElement) || !(code instanceof HTMLInputElement) || !(codeLabel instanceof HTMLLabelElement) ||
      !(submit instanceof HTMLButtonElement) || !(resend instanceof HTMLButtonElement) || !feedback) return;
  feedback.textContent = message;
  email.focus();

  async function sendCode() {
    if (!(email instanceof HTMLInputElement) || !(code instanceof HTMLInputElement) ||
        !(codeLabel instanceof HTMLLabelElement) || !submit || !(resend instanceof HTMLButtonElement) || !feedback) return;
    await requestCode(email.value.trim());
    email.readOnly = true;
    codeLabel.hidden = false;
    code.required = true;
    submit.textContent = "Anmelden";
    resend.hidden = false;
    feedback.textContent = "Wenn diese Adresse freigeschaltet ist, erhältst du einen Anmeldecode per E-Mail.";
    code.value = "";
    code.focus();
  }

  /** @param {() => Promise<void>} action */
  async function run(action) {
    if (!(submit instanceof HTMLButtonElement) || !(resend instanceof HTMLButtonElement) || !feedback) return;
    submit.disabled = true;
    resend.disabled = true;
    feedback.textContent = "";
    try {
      await action();
    } catch (cause) {
      feedback.textContent = errorMessage(cause);
    } finally {
      submit.disabled = false;
      resend.disabled = false;
    }
  }
  resend.addEventListener("click", () => void run(sendCode));
  form.addEventListener("submit", event => {
    event.preventDefault();
    void run(codeLabel.hidden ? sendCode : async () => {
      await signIn(email.value.trim(), code.value.trim().toUpperCase());
      await onSuccess();
    });
  });
}
