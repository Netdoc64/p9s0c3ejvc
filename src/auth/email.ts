/**
 * Mail-Versand für Login-Codes (Magic Link) über Cloudflare Email Service.
 *
 * Der Worker sendet über das `send_email`-Binding `EMAIL` — kein API-Schlüssel.
 * Die Absenderadresse kommt aus `MAIL_FROM` (Worker-Variable, nicht im Repo);
 * ihre Domain muss im Cloudflare-Konto für Email Sending freigeschaltet sein
 * (`wrangler email sending list`).
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

/** Die Form des `send_email`-Bindings, soweit wir sie nutzen (Workers-Runtime). */
export interface SendEmailBinding {
  send(msg: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
}

export const consoleEmailAdapter: EmailAdapter = {
  async send(msg) {
    console.log(JSON.stringify({ event: "email.sent", to_hash: await hashTo(msg.to), subject: msg.subject }));
  },
};

async function hashTo(to: string): Promise<string> {
  const data = new TextEncoder().encode(to);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 4; i++) hex += (bytes[i] as number).toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

export class CloudflareEmailAdapter implements EmailAdapter {
  constructor(private binding: SendEmailBinding, private from: string, private fromName = "Grosshandel") {}
  async send(msg: EmailMessage): Promise<void> {
    // Fehler des Bindings (E_SENDER_NOT_VERIFIED, E_RATE_LIMIT_EXCEEDED, …)
    // werfen weiter: der Aufrufer meldet sie, statt „ok“ zu sagen.
    await this.binding.send({
      to: msg.to,
      from: { email: this.from, name: this.fromName },
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
  }
}

/**
 * WELCHER ADAPTER GILT, ENTSCHEIDET DIE UMGEBUNG — nicht ein Aufruf, den man
 * vergessen kann. Bis 2026-11-17 rief kein Produktionscode `setEmailAdapter`;
 * der Login-Code ging in JEDER Umgebung an den console-Sink (nur ein Hash im
 * Log), und `/magic-link/request` meldete trotzdem `ok`. Kein Kunde hätte sich
 * je anmelden können — ein „Erfolg“ ohne Zustellung.
 *
 * - Test-Override (`setEmailAdapter`) schlägt alles.
 * - Binding `EMAIL` + `MAIL_FROM` vorhanden → Cloudflare Email Service.
 * - sonst in `development` → console-Sink.
 * - sonst (staging/production) → `null`: der Aufrufer MUSS mit GH-EXT-003
 *   abbrechen, statt „ok“ zu melden.
 */
let override: EmailAdapter | null = null;
export function setEmailAdapter(a: EmailAdapter): void { override = a; }
export function resetEmailAdapter(): void { override = null; }

export interface EmailEnv {
  ENVIRONMENT: string;
  EMAIL?: SendEmailBinding;
  MAIL_FROM?: string;
}

export function email(env: EmailEnv): EmailAdapter | null {
  if (override) return override;
  if (env.EMAIL && env.MAIL_FROM) return new CloudflareEmailAdapter(env.EMAIL, env.MAIL_FROM);
  if (env.ENVIRONMENT === "development") return consoleEmailAdapter;
  return null;
}
