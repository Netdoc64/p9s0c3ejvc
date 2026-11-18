import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: R2Bucket;
  OUTBOX_QUEUE: Queue<OutboxMessage>;
  STOCK_DO: DurableObjectNamespace;
  // #C-012: Pflicht-Bindings (vorher optional fürs Test-Setup; Tests sollten mocks bereitstellen).
  CRON_LOCK_DO: DurableObjectNamespace;
  INVOICE_NUMBER_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  RETURNS_DO: DurableObjectNamespace;
  RETURNS_SUPPLIER_EDGE?: Fetcher;

  WORKER_VERSION: string;
  ENVIRONMENT: "development" | "staging" | "production";

  GIT_COMMIT?: string;
  /** Komma-Liste der Web-Origins der Kunden-App, für die /v1/customer/* CORS bekommt. */
  CUSTOMER_APP_ORIGINS?: string;
  FLORIDAY_CONNECTIONS?: string;
  KOMANDER_CONNECTIONS?: string;
  FLEUROP_NL_CONNECTIONS?: string;
  FSN_CONNECTIONS?: string;

  // Mail-Zustellung für Login-Codes: Cloudflare Email Service (Binding
  // `send_email`) und die Absenderadresse als Worker-Variable (nicht im Repo).
  // Fehlt eines außerhalb von development, antwortet /magic-link/request mit
  // GH-EXT-003 statt „ok“.
  EMAIL?: import("./auth/email").SendEmailBinding;
  MAIL_FROM?: string;
}

export interface OutboxMessage {
  event_id: string;
  subscription_id?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: AppVariables;
};

export interface AppVariables {
  request_id: string;
  tenant_id?: string;
  api_key_id?: string;
  customer_id?: string;
  scopes?: string[];
}
