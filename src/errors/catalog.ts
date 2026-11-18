// Source-of-Truth: docs/orchestration/_errors.md
// Diese Datei wird Hand-gepflegt parallel — bei Erweiterung BEIDE Stellen.

export type ErrorCategory = "client_error" | "server_error" | "external_error";
export type RetryStrategy = "none" | "exponential" | "manual";

export interface ErrorEntry {
  code: string;
  http_status: number;
  category: ErrorCategory;
  retry: RetryStrategy;
  user_message: string;
  internal_detail: string;
  status: "active" | "deprecated";
}

export const ERROR_CATALOG = {
  // AUTH
  "GH-AUTH-001": { code: "GH-AUTH-001", http_status: 401, category: "client_error", retry: "none", user_message: "Authentifizierung fehlgeschlagen.", internal_detail: "Missing or unknown X-Api-Key", status: "active" },
  "GH-AUTH-002": { code: "GH-AUTH-002", http_status: 401, category: "client_error", retry: "none", user_message: "Authentifizierung fehlgeschlagen.", internal_detail: "HMAC signature mismatch", status: "active" },
  "GH-AUTH-003": { code: "GH-AUTH-003", http_status: 401, category: "client_error", retry: "none", user_message: "Authentifizierung fehlgeschlagen.", internal_detail: "Timestamp outside 5min skew window", status: "active" },
  "GH-AUTH-004": { code: "GH-AUTH-004", http_status: 403, category: "client_error", retry: "none", user_message: "Zugriff nicht erlaubt.", internal_detail: "Scope insufficient for operation", status: "active" },
  "GH-AUTH-005": { code: "GH-AUTH-005", http_status: 401, category: "client_error", retry: "none", user_message: "Authentifizierung fehlgeschlagen.", internal_detail: "JWT/MCP token expired or revoked", status: "active" },
  "GH-AUTH-006": { code: "GH-AUTH-006", http_status: 410, category: "client_error", retry: "none", user_message: "Code abgelaufen, bitte neuen anfordern.", internal_detail: "Magic-link or authorization code expired", status: "active" },
  "GH-AUTH-007": { code: "GH-AUTH-007", http_status: 401, category: "client_error", retry: "none", user_message: "Sitzung ungültig, bitte neu anmelden.", internal_detail: "Refresh-token replay detected — all customer refresh tokens invalidated", status: "active" },
  "GH-AUTH-008": { code: "GH-AUTH-008", http_status: 400, category: "client_error", retry: "none", user_message: "Ungültige Anmeldung.", internal_detail: "PKCE code_verifier does not match challenge", status: "active" },

  // TENANT
  "GH-TENANT-001": { code: "GH-TENANT-001", http_status: 404, category: "client_error", retry: "none", user_message: "Resource nicht gefunden.", internal_detail: "Cross-tenant access attempted (treat as 404, no leak)", status: "active" },
  "GH-TENANT-002": { code: "GH-TENANT-002", http_status: 409, category: "client_error", retry: "none", user_message: "Tenant-Setup unvollständig.", internal_detail: "Tenant exists but missing required config", status: "active" },

  // IDEMP
  "GH-IDEMP-001": { code: "GH-IDEMP-001", http_status: 409, category: "client_error", retry: "none", user_message: "Identische Anfrage mit anderem Inhalt.", internal_detail: "Same idempotency key, different payload hash", status: "active" },

  // INPUT
  "GH-INPUT-001": { code: "GH-INPUT-001", http_status: 400, category: "client_error", retry: "none", user_message: "Ungültige Eingabe.", internal_detail: "Zod validation failure", status: "active" },
  "GH-INPUT-002": { code: "GH-INPUT-002", http_status: 413, category: "client_error", retry: "none", user_message: "Datei zu gross.", internal_detail: "Upload exceeds tenant quota", status: "active" },

  // CUST
  "GH-CUST-001": { code: "GH-CUST-001", http_status: 404, category: "client_error", retry: "none", user_message: "Kunde nicht gefunden.", internal_detail: "Customer id not found in tenant", status: "active" },
  "GH-CUST-002": { code: "GH-CUST-002", http_status: 409, category: "client_error", retry: "none", user_message: "Kunde existiert bereits.", internal_detail: "Duplicate customer (e.g. by VAT-ID)", status: "active" },
  "GH-CUST-003": { code: "GH-CUST-003", http_status: 422, category: "client_error", retry: "none", user_message: "Kunde ist gesperrt.", internal_detail: "Customer.blocked=true", status: "active" },
  "GH-CUST-004": { code: "GH-CUST-004", http_status: 422, category: "client_error", retry: "none", user_message: "Kreditrahmen überschritten.", internal_detail: "Order would exceed credit_limit", status: "active" },

  // VIES
  "GH-VIES-001": { code: "GH-VIES-001", http_status: 422, category: "client_error", retry: "none", user_message: "VAT-ID ungültig.", internal_detail: "VIES returned invalid", status: "active" },
  "GH-VIES-002": { code: "GH-VIES-002", http_status: 503, category: "external_error", retry: "exponential", user_message: "VIES-Service vorübergehend nicht erreichbar.", internal_detail: "VIES timeout/5xx; cache fallback used (warn)", status: "active" },

  // PROD
  "GH-PROD-001": { code: "GH-PROD-001", http_status: 404, category: "client_error", retry: "none", user_message: "Produkt nicht gefunden.", internal_detail: "SKU id unknown for tenant", status: "active" },
  "GH-PROD-002": { code: "GH-PROD-002", http_status: 422, category: "client_error", retry: "none", user_message: "Bestelleinheit nicht erlaubt.", internal_detail: "Requested unit not in product.packaging", status: "active" },
  "GH-PROD-003": { code: "GH-PROD-003", http_status: 422, category: "client_error", retry: "none", user_message: "Mindestbestellmenge unterschritten.", internal_detail: "qty < min_order_qty", status: "active" },

  // PRICE
  "GH-PRICE-001": { code: "GH-PRICE-001", http_status: 422, category: "client_error", retry: "none", user_message: "Kein Preis hinterlegt.", internal_detail: "No applicable price list for (customer, sku, date)", status: "active" },
  "GH-PRICE-002": { code: "GH-PRICE-002", http_status: 422, category: "client_error", retry: "none", user_message: "Preisliste abgelaufen.", internal_detail: "Price list valid_to < now", status: "active" },

  // TAX
  "GH-TAX-001": { code: "GH-TAX-001", http_status: 422, category: "client_error", retry: "none", user_message: "Steuerregel nicht ableitbar.", internal_detail: "No tax rule matches (tenant_country, customer_country, b2b/b2c, vat_status)", status: "active" },

  // STOCK
  "GH-STOCK-001": { code: "GH-STOCK-001", http_status: 409, category: "client_error", retry: "none", user_message: "Bestand nicht ausreichend.", internal_detail: "available < requested", status: "active" },
  "GH-STOCK-002": { code: "GH-STOCK-002", http_status: 410, category: "client_error", retry: "none", user_message: "Reservierung abgelaufen.", internal_detail: "reservation_id TTL exceeded", status: "active" },
  "GH-STOCK-003": { code: "GH-STOCK-003", http_status: 503, category: "external_error", retry: "exponential", user_message: "Lager-Service vorübergehend nicht erreichbar.", internal_detail: "Durable Object unreachable", status: "active" },

  // ORDER
  "GH-ORDER-001": { code: "GH-ORDER-001", http_status: 404, category: "client_error", retry: "none", user_message: "Bestellung nicht gefunden.", internal_detail: "Order id unknown for tenant", status: "active" },
  "GH-ORDER-002": { code: "GH-ORDER-002", http_status: 409, category: "client_error", retry: "none", user_message: "Bestellung wurde verändert.", internal_detail: "etag mismatch on update", status: "active" },
  "GH-ORDER-003": { code: "GH-ORDER-003", http_status: 422, category: "client_error", retry: "none", user_message: "Bestellung kann nicht bestätigt werden.", internal_detail: "Gates not all passing", status: "active" },

  // RETURNS
  "GH-RET-001": { code: "GH-RET-001", http_status: 404, category: "client_error", retry: "none", user_message: "Retourenfall oder Position nicht gefunden.", internal_detail: "Case or position unknown or inaccessible", status: "active" },
  "GH-RET-002": { code: "GH-RET-002", http_status: 409, category: "client_error", retry: "none", user_message: "Der Vorgang ist im aktuellen Fallstand nicht möglich.", internal_detail: "Case version, quantity, state or booking reference conflict", status: "active" },
  "GH-RET-003": { code: "GH-RET-003", http_status: 503, category: "external_error", retry: "exponential", user_message: "Die Übergabe wartet auf die Bestätigung des Lieferanten.", internal_detail: "Supplier receipt unavailable, retry with the same command ID", status: "active" },

  // STATE
  "GH-STATE-001": { code: "GH-STATE-001", http_status: 409, category: "client_error", retry: "none", user_message: "Übergang nicht erlaubt.", internal_detail: "Transition X→Y not in allowed_transitions", status: "active" },

  // WEBH
  "GH-WEBH-001": { code: "GH-WEBH-001", http_status: 502, category: "external_error", retry: "exponential", user_message: "(intern, kein User)", internal_detail: "Receiver returned 5xx", status: "active" },
  "GH-WEBH-002": { code: "GH-WEBH-002", http_status: 0, category: "external_error", retry: "none", user_message: "(intern, kein User)", internal_detail: "Max retries exhausted, dead-letter", status: "active" },

  // MCP
  "GH-MCP-001": { code: "GH-MCP-001", http_status: 422, category: "client_error", retry: "none", user_message: "Position nicht eindeutig — bitte präzisieren.", internal_detail: "SKU resolution confidence < threshold", status: "active" },
  "GH-MCP-002": { code: "GH-MCP-002", http_status: 422, category: "client_error", retry: "none", user_message: "Bestätigung erforderlich.", internal_detail: "Agent attempted commit without confirm step", status: "active" },

  // EXT
  "GH-EXT-001": { code: "GH-EXT-001", http_status: 502, category: "external_error", retry: "exponential", user_message: "Buchhaltung vorübergehend nicht erreichbar.", internal_detail: "buchhaltung_eu unreachable", status: "active" },
  "GH-EXT-002": { code: "GH-EXT-002", http_status: 502, category: "external_error", retry: "exponential", user_message: "Externer Dienst nicht erreichbar.", internal_detail: "Generic external 5xx", status: "active" },
  "GH-EXT-003": { code: "GH-EXT-003", http_status: 503, category: "external_error", retry: "manual", user_message: "Anmeldung per E-Mail ist derzeit nicht verfügbar.", internal_detail: "No mail transport configured (EMAIL binding or MAIL_FROM missing outside development)", status: "active" },

  // INFRA
  "GH-INFRA-001": { code: "GH-INFRA-001", http_status: 503, category: "server_error", retry: "exponential", user_message: "Service vorübergehend überlastet.", internal_detail: "D1/KV/R2/Queue unreachable", status: "active" },
  "GH-INFRA-002": { code: "GH-INFRA-002", http_status: 500, category: "server_error", retry: "none", user_message: "Interner Fehler.", internal_detail: "Unexpected exception (Sentry-tagged)", status: "active" },

  // RATE
  "GH-RATE-001": { code: "GH-RATE-001", http_status: 429, category: "client_error", retry: "manual", user_message: "Zu viele Anfragen, bitte später.", internal_detail: "Rate-limit bucket exhausted (class-level)", status: "active" },
  "GH-RATE-002": { code: "GH-RATE-002", http_status: 429, category: "client_error", retry: "manual", user_message: "Tarifgrenze erreicht.", internal_detail: "Tenant tier quota exceeded", status: "active" },

  // CLIENT
  "GH-CLIENT-001": { code: "GH-CLIENT-001", http_status: 426, category: "client_error", retry: "none", user_message: "Bitte App aktualisieren.", internal_detail: "Client version < min_supported, sunset reached", status: "active" },

  // CRON
  "GH-CRON-001": { code: "GH-CRON-001", http_status: 0, category: "server_error", retry: "manual", user_message: "(intern, kein User)", internal_detail: "Scheduled job failed; auto-paused after 3", status: "active" },

  // SUPPLIER
  "GH-SUPPLIER-001": { code: "GH-SUPPLIER-001", http_status: 503, category: "external_error", retry: "manual", user_message: "Lieferanten-Anbindung ist nicht verfügbar.", internal_detail: "Supplier connection missing or invalid", status: "active" },
  "GH-SUPPLIER-002": { code: "GH-SUPPLIER-002", http_status: 404, category: "client_error", retry: "none", user_message: "Lieferantenangebot oder Einkaufsbestellung nicht gefunden.", internal_detail: "Supplier record missing for tenant", status: "active" },
  "GH-SUPPLIER-003": { code: "GH-SUPPLIER-003", http_status: 409, category: "client_error", retry: "manual", user_message: "Lieferantenangebot oder Einkaufsbestellung wurde verändert.", internal_detail: "Supplier offer or purchase order conflict", status: "active" },

  // FEED
  "GH-FEED-001": { code: "GH-FEED-001", http_status: 503, category: "external_error", retry: "exponential", user_message: "(intern, kein User)", internal_detail: "Pricing feed endpoint unreachable", status: "active" },
  "GH-FEED-002": { code: "GH-FEED-002", http_status: 0, category: "external_error", retry: "none", user_message: "(intern, kein User)", internal_detail: "Pricing feed format invalid OR drift threshold breached", status: "active" },

  // PERISH
  "GH-FEFO-001": { code: "GH-FEFO-001", http_status: 422, category: "client_error", retry: "none", user_message: "Bestand mit ausreichender Restlaufzeit nicht verfügbar.", internal_detail: "No batch matches min_shelf_life_days", status: "active" },
  "GH-PERISH-001": { code: "GH-PERISH-001", http_status: 422, category: "client_error", retry: "none", user_message: "Bestand abgelaufen.", internal_detail: "Batch already expired at reservation time", status: "active" },

  // PDF
  "GH-PDF-001": { code: "GH-PDF-001", http_status: 500, category: "server_error", retry: "manual", user_message: "Rechnung konnte nicht erstellt werden.", internal_detail: "Invoice PDF generation failed (validation, R2, lib OOM)", status: "active" },
  "GH-PDF-003": { code: "GH-PDF-003", http_status: 404, category: "client_error", retry: "none", user_message: "Für diese Bestellung gibt es noch keine Rechnung.", internal_detail: "Order has no invoice (not confirmed yet, or generation failed)", status: "active" },
  "GH-PDF-002": { code: "GH-PDF-002", http_status: 422, category: "client_error", retry: "manual", user_message: "Rechnung kann nicht ausgestellt werden: Pflichtangaben des Verkäufers fehlen.", internal_detail: "Tenant lacks vat_id and/or address (Art. 226 MwStSysRL); no invoice issued", status: "active" },

  // PUSH
  "GH-PUSH-001": { code: "GH-PUSH-001", http_status: 502, category: "external_error", retry: "exponential", user_message: "(intern)", internal_detail: "APNs/FCM provider unreachable", status: "active" },
  "GH-PUSH-002": { code: "GH-PUSH-002", http_status: 0, category: "external_error", retry: "none", user_message: "(intern)", internal_detail: "Device token invalid; auto-cleanup", status: "active" },

  // OBS
  "GH-OBS-001": { code: "GH-OBS-001", http_status: 0, category: "server_error", retry: "none", user_message: "(intern)", internal_detail: "Logging sink unreachable; fail-open with worker-logs backup", status: "active" },

  // SECRET
  "GH-SECRET-001": { code: "GH-SECRET-001", http_status: 409, category: "server_error", retry: "none", user_message: "(intern)", internal_detail: "Secret rotation conflict or generation failure", status: "active" },

  // DR
  "GH-DR-001": { code: "GH-DR-001", http_status: 0, category: "server_error", retry: "manual", user_message: "(intern)", internal_detail: "Backup target unreachable or integrity-hash mismatch", status: "active" },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: Record<string, unknown>, message?: string) {
    super(message ?? ERROR_CATALOG[code].internal_detail);
    this.code = code;
    this.detail = detail;
    this.name = "CodedError";
  }
}

export function isCodedError(e: unknown): e is CodedError {
  return e instanceof CodedError;
}

export function lookup(code: ErrorCode): ErrorEntry {
  return ERROR_CATALOG[code];
}
