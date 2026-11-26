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
  /** Komma-Liste der Web-Origins des Händler-Dashboards (CORS für /v1/* mit Mitarbeiter-Token). */
  STAFF_APP_ORIGINS?: string;
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

  // Schlüssel für /admin/* (nur Business Manager). Fehlt er, sind die
  // Admin-Endpunkte aus (GH-ADMIN-002), nicht offen.
  ADMIN_API_KEY?: string;
  // Hauptschlüssel für die Zugangsdaten der Module (64 Hex). Fehlt er, lassen
  // sich keine Zugänge speichern (GH-MODULE-002); gelesen wird dann nur das
  // alte Sammel-Secret.
  MODULE_KEK?: string;
}

export interface OutboxMessage {
  event_id: string;
  subscription_id?: string;
}

/**
 * Interner Betriebs-Auftrag (kein Outbox-Event): StockDO-Bestand aus D1 neu
 * aufbauen. Nur wer an die Queue senden darf (Binding/wrangler), kann ihn
 * auslösen — es gibt keine HTTP-Route dafür. `targets` optional: ein
 * geprüfter Plan (scripts/rebuild-stock.ts --out); ohne Angabe wird der Plan
 * aus stock_movements/stock_batches berechnet.
 */
export interface StockRebuildMessage {
  kind: "stock_rebuild";
  force?: boolean;
  targets?: import("./services/stock-rebuild").StockTarget[];
}

export type QueueMessage = OutboxMessage | StockRebuildMessage;

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
  staff_id?: string;
  staff_role?: "owner" | "staff";
}
