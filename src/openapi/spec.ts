/**
 * OpenAPI 3.1 Spec für die Grosshandel-API.
 *
 * Quelle der Wahrheit: alle Zod-Schemas aus src/schemas/* + src/db/schema/*.
 * Spec wird aus den Zod-Schemas gebaut (z.toJSONSchema), zur Laufzeit auf
 * /openapi.json + /schemas/order.json serviert.
 *
 * Drift-Schutz: tests/openapi/spec.spec.ts validiert dass jede in src/index.ts
 * mounted Route hier dokumentiert ist.
 */

import { fsnOrderInput } from "../integrations/flower-shop-network";
import { fleuropOrder, fleuropReconcile } from "../integrations/fleurop";
import { komanderCheckout } from "../integrations/komander";
import { purchaseInput } from "../integrations/floriday";
import { snapshotInput, snapshotOffer, snapshotSku, snapshotSource } from "../integrations/supplier-snapshots";
import { toJsonSchema, type JsonSchema } from "./json-schema";
import type { z } from "zod";
import { CreateReturnInput, DeliveryInput, ReturnCommandInput, ReturnRef, SupplierHandoff } from "../schemas/returns";
import { OrderDocSchema, CreateOrderRequestSchema, OrderStateSchema, StepTypeSchema } from "../schemas/order";
import { CustomerCreateSchema, CustomerPatchSchema, AddressSchema } from "../schemas/customer";
import { ProductCreateSchema, ProductPatchSchema, PackagingUnitSchema, TaxClassSchema } from "../schemas/product";

function toSchema(s: z.ZodType, name?: string): JsonSchema {
  const json = toJsonSchema(s);
  return name ? { title: name, ...json } : json;
}

const ProblemSchema = {
  type: "object",
  required: ["type", "title", "status", "detail", "instance", "code"],
  properties: {
    type: { type: "string", format: "uri", example: "https://errors.grosshandel.app/GH-AUTH-001" },
    title: { type: "string", example: "Authentifizierung fehlgeschlagen." },
    status: { type: "integer", example: 401 },
    detail: { type: "string" },
    instance: { type: "string", example: "01HZK..." },
    code: { type: "string", example: "GH-AUTH-001" },
    // Extension-Keys (#L-008, #L-009) — code-abhängig, nicht jeder Code setzt sie:
    issues: { type: "object", description: "Zod-Validation-Issues bei GH-INPUT-001 (fieldErrors, formErrors).", additionalProperties: true },
    cause: { type: "string", description: "Error.message bei GH-INFRA-002. Nur non-production (#L-002)." },
    reason: { type: "string", description: "Free-form-Detail (z.B. 'missing X-Tenant-Slug')." },
    field: { type: "string", description: "Feldname bei Cursor-/Param-Fehlern." },
  },
  additionalProperties: true,
} as const;

const CustomerSchemaJson = {
  type: "object",
  required: ["id", "tenant_id", "name", "country", "b2b_b2c", "vat_status"],
  properties: {
    id: { type: "string", pattern: "^cust_" },
    tenant_id: { type: "string", pattern: "^t_" },
    external_id: { type: ["string", "null"] },
    name: { type: "string" },
    email: { type: ["string", "null"] },
    phone: { type: ["string", "null"] },
    country: { type: "string" },
    b2b_b2c: { type: "string", enum: ["b2b", "b2c"] },
    vat_id: { type: ["string", "null"] },
    vat_status: { type: "string", enum: ["valid", "invalid", "unknown", "not_required"] },
    vies_checked_at: { type: ["string", "null"], format: "date-time" },
    language: { type: ["string", "null"] },
    credit_limit_cents: { type: ["integer", "null"] },
    blocked: { type: "integer" },
    addresses: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    deleted_at: { type: ["string", "null"] },
  },
} as const;

const ProductSchemaJson = {
  type: "object",
  required: ["id", "tenant_id", "sku_code", "name", "tax_class"],
  properties: {
    id: { type: "string", pattern: "^sku_" },
    tenant_id: { type: "string", pattern: "^t_" },
    sku_code: { type: "string" },
    parent_sku_id: { type: ["string", "null"] },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    tax_class: { type: "string", enum: ["standard", "reduced", "zero"] },
    is_perishable: { type: "integer", enum: [0, 1] },
    default_shelf_life_days: { type: ["integer", "null"] },
    min_order_qty: { type: "integer" },
    packaging_units: { type: "array", items: toSchema(PackagingUnitSchema) },
    attributes: { type: "object", additionalProperties: true },
    status: { type: "string" },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

const PricingResultJson = {
  type: "object",
  required: ["unit_price_cents", "breakdown", "decision_reason", "currency"],
  properties: {
    unit_price_cents: { type: "integer" },
    breakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule: { type: "string", enum: ["customer_special", "qty_break_absolute", "qty_break_pct", "list_item"] },
          applied: { type: "boolean" },
          value_cents: { type: "integer" },
          detail: { type: "string" },
        },
      },
    },
    list_id: { type: ["string", "null"] },
    decision_reason: { type: "string" },
    currency: { type: "string" },
  },
} as const;

const StockStateJson = {
  type: "object",
  required: ["available", "reserved"],
  properties: {
    available: { type: "integer" },
    reserved: { type: "integer" },
  },
} as const;

const OrderDocJson = toSchema(OrderDocSchema, "OrderDocument");
const CreateOrderRequestJson = toSchema(CreateOrderRequestSchema, "CreateOrderRequest");
const CustomerCreateJson = toSchema(CustomerCreateSchema, "CustomerCreate");
const CustomerPatchJson = toSchema(CustomerPatchSchema, "CustomerPatch");
const ProductCreateJson = toSchema(ProductCreateSchema, "ProductCreate");
const ProductPatchJson = toSchema(ProductPatchSchema, "ProductPatch");
const AddressJson = toSchema(AddressSchema, "Address");
const TaxClassJson = toSchema(TaxClassSchema, "TaxClass");
const OrderStateJson = toSchema(OrderStateSchema, "OrderState");
const StepTypeJson = toSchema(StepTypeSchema, "StepType");

// ---------- Helpers ----------

const TENANT_AUTH = [{ tenant_hmac: [] }];
const CUSTOMER_AUTH = [{ customer_jwt: [] }];

const IDEMPOTENCY_HEADER = {
  name: "X-Idempotency-Key",
  in: "header" as const,
  required: false,
  description: "Optional. Server cached 2xx-Response 24h. Gleicher Key + anderer Body → 409 GH-IDEMP-001.",
  schema: { type: "string", maxLength: 120 },
};

const TENANT_SLUG_HEADER = {
  name: "X-Tenant-Slug",
  in: "header" as const,
  required: true,
  description: "Tenant-Slug (z.B. 'pilot').",
  schema: { type: "string" },
};

const CLIENT_HEADERS = [
  { name: "X-Client-Version", in: "header" as const, required: true, description: "SemVer des Clients (z.B. '1.4.10').", schema: { type: "string" } },
  { name: "X-Client-Platform", in: "header" as const, required: true, description: "Plattform des Clients.", schema: { type: "string", enum: ["ios", "android", "web"] } },
];

const PROBLEM_RESPONSE = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const JSON_RESPONSE = (description: string, schema: JsonSchema, status: number = 200): [string, { description: string; content: Record<string, { schema: JsonSchema }> }] => [
  String(status),
  { description, content: { "application/json": { schema } } },
];

// ---------- Paths ----------

interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
}

interface Operation {
  tags?: string[];
  summary: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<Record<string, unknown>>;
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, unknown>;
}

const paths: Record<string, PathItem> = {};

// HEALTH
paths["/health"] = {
  get: {
    tags: ["health"],
    summary: "Liveness + Version",
    operationId: "getHealth",
    responses: Object.fromEntries([
      JSON_RESPONSE("Service ist healthy", {
        type: "object",
        required: ["status", "version", "commit", "environment"],
        properties: {
          status: { type: "string", enum: ["ok"] },
          version: { type: "string" },
          commit: { type: "string" },
          environment: { type: "string" },
        },
      }),
    ]),
  },
};

// AUTH (Customer-Auth, tenant-public via X-Tenant-Slug)
paths["/v1/auth/magic-link/request"] = {
  post: {
    tags: ["auth"],
    summary: "Magic-Link-Code anfordern",
    description: "Sendet einen 8-stelligen Code per Email. TTL 10min, max 1 aktiver Code pro Customer. User-Enumeration-Schutz: gleiche Antwort auch bei unbekannter Email. Rate-Limit 3/min.",
    operationId: "magicLinkRequest",
    parameters: [TENANT_SLUG_HEADER],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } },
    },
    responses: {
      ...Object.fromEntries([JSON_RESPONSE("Akzeptiert (immer 200, unabhängig davon ob Email bekannt)", { type: "object", properties: { ok: { type: "boolean" }, ttl_sec: { type: "integer" } } })]),
      400: PROBLEM_RESPONSE("Validation"),
      404: PROBLEM_RESPONSE("Tenant unbekannt"),
      503: PROBLEM_RESPONSE("GH-EXT-003: kein Mail-Versand konfiguriert (statt still „ok“)"),
      429: PROBLEM_RESPONSE("Rate-Limit"),
    },
  },
};

paths["/v1/auth/magic-link/verify"] = {
  post: {
    tags: ["auth"],
    summary: "Magic-Link-Code einlösen",
    description: "Tauscht Email+Code gegen Access-Token (JWT, 15min) + Refresh-Token (90d, rotierbar).",
    operationId: "magicLinkVerify",
    parameters: [TENANT_SLUG_HEADER],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["email", "code"], properties: { email: { type: "string", format: "email" }, code: { type: "string", minLength: 4, maxLength: 8 } } } } },
    },
    responses: {
      ...Object.fromEntries([JSON_RESPONSE("Token-Pair", {
        type: "object",
        required: ["access_token", "refresh_token", "token_type", "expires_in", "scope"],
        properties: {
          access_token: { type: "string" },
          refresh_token: { type: "string" },
          token_type: { type: "string", enum: ["Bearer"] },
          expires_in: { type: "integer" },
          scope: { type: "string" },
        },
      })]),
      410: PROBLEM_RESPONSE("Code abgelaufen oder ungültig"),
    },
  },
};

paths["/v1/auth/oauth/authorize"] = {
  post: {
    tags: ["auth"],
    summary: "OAuth 2.1 + PKCE Authorize (POST-basiert)",
    description: "v1-Pragma: Magic-Link-Verifikation inline mit PKCE-Challenge → erhält authorization_code direkt zurück (kein Browser-Redirect). Code TTL 5min.",
    operationId: "oauthAuthorize",
    parameters: [TENANT_SLUG_HEADER],
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object",
        required: ["client_id", "response_type", "code_challenge", "code_challenge_method", "email", "magic_link_code"],
        properties: {
          client_id: { type: "string" },
          redirect_uri: { type: "string", format: "uri" },
          response_type: { type: "string", enum: ["code"] },
          code_challenge: { type: "string", minLength: 43, maxLength: 128 },
          code_challenge_method: { type: "string", enum: ["S256"] },
          scope: { type: "string", default: "customer_self" },
          state: { type: "string" },
          email: { type: "string", format: "email" },
          magic_link_code: { type: "string" },
        },
      } } },
    },
    responses: {
      ...Object.fromEntries([JSON_RESPONSE("Authorization-Code", {
        type: "object",
        properties: { code: { type: "string" }, state: { type: "string" }, expires_in: { type: "integer" } },
      })]),
      410: PROBLEM_RESPONSE("Magic-Link-Code abgelaufen"),
    },
  },
};

paths["/v1/auth/oauth/token"] = {
  post: {
    tags: ["auth"],
    summary: "OAuth-Token-Endpoint (code+verifier oder refresh_token)",
    description: "Tauscht authorization_code+code_verifier gegen Token-Pair, oder rotiert refresh_token. Replay-Detection: alter Refresh-Token wird nach Rotation invalidiert; doppelte Verwendung → ALLE Tokens der Family revoked (`GH-AUTH-007`).",
    operationId: "oauthToken",
    parameters: [TENANT_SLUG_HEADER],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { oneOf: [
        { type: "object", required: ["grant_type", "code", "code_verifier", "client_id"], properties: {
          grant_type: { type: "string", enum: ["authorization_code"] },
          code: { type: "string" },
          code_verifier: { type: "string" },
          client_id: { type: "string" },
          redirect_uri: { type: "string" },
        } },
        { type: "object", required: ["grant_type", "refresh_token"], properties: {
          grant_type: { type: "string", enum: ["refresh_token"] },
          refresh_token: { type: "string" },
        } },
      ] } } },
    },
    responses: {
      ...Object.fromEntries([JSON_RESPONSE("Token-Pair", {
        type: "object",
        properties: {
          access_token: { type: "string" }, refresh_token: { type: "string" },
          token_type: { type: "string" }, expires_in: { type: "integer" }, scope: { type: "string" },
        },
      })]),
      400: PROBLEM_RESPONSE("PKCE-Verifier mismatch"),
      401: PROBLEM_RESPONSE("Token expired/invalid/replay"),
    },
  },
};

paths["/v1/auth/oauth/revoke"] = {
  post: {
    tags: ["auth"],
    summary: "Refresh-Token revoken",
    operationId: "oauthRevoke",
    parameters: [TENANT_SLUG_HEADER],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" }, token_type_hint: { type: "string", enum: ["refresh_token"] } } } } },
    },
    responses: { 204: { description: "Revoked" } },
  },
};

// CUSTOMERS
paths["/v1/customers"] = {
  post: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "Customer anlegen",
    description: "VIES-VAT-Validation läuft automatisch (24h KV-Cache, 5s-Timeout-Fallback → vat_status='unknown').",
    operationId: "createCustomer",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: CustomerCreateJson } } },
    responses: {
      201: { description: "Customer angelegt", content: { "application/json": { schema: CustomerSchemaJson } } },
      400: PROBLEM_RESPONSE("Validation"), 409: PROBLEM_RESPONSE("Doppelte VAT-ID"),
    },
  },
  get: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "Customer-Liste (cursor-paginiert)",
    operationId: "listCustomers",
    parameters: [
      { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque base64-Token aus vorhergehender Antwort" },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: {
      200: { description: "Liste", content: { "application/json": { schema: { type: "object", required: ["items", "next_cursor"], properties: { items: { type: "array", items: CustomerSchemaJson }, next_cursor: { type: ["string", "null"] } } } } } },
    },
  },
};

paths["/v1/customers/{id}"] = {
  get: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "Customer lesen", operationId: "getCustomer",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^cust_" } }],
    responses: { 200: { description: "Customer", content: { "application/json": { schema: CustomerSchemaJson } } }, 404: PROBLEM_RESPONSE("Cross-Tenant oder unbekannt") },
  },
  patch: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "Customer ändern", operationId: "patchCustomer",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^cust_" } },
      IDEMPOTENCY_HEADER,
    ],
    requestBody: { required: true, content: { "application/json": { schema: CustomerPatchJson } } },
    responses: { 200: { description: "Updated", content: { "application/json": { schema: CustomerSchemaJson } } }, 404: PROBLEM_RESPONSE("Nicht gefunden") },
  },
  delete: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "Customer Soft-Delete", operationId: "deleteCustomer",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^cust_" } }],
    responses: { 204: { description: "Deleted" }, 404: PROBLEM_RESPONSE("Nicht gefunden") },
  },
};

// PRODUCTS
paths["/v1/products"] = {
  post: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt anlegen", operationId: "createProduct",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: ProductCreateJson } } },
    responses: { 201: { description: "Created", content: { "application/json": { schema: ProductSchemaJson } } }, 404: PROBLEM_RESPONSE("Duplicate sku_code") },
  },
  get: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt-Liste", operationId: "listProducts",
    parameters: [
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
    ],
    responses: { 200: { description: "Liste", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: ProductSchemaJson }, next_cursor: { type: ["string", "null"] } } } } } } },
  },
};

paths["/v1/products/search"] = {
  get: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Volltext-Suche", operationId: "searchProducts",
    description: "LIKE-Suche über name/sku_code/description/attributes mit Token-Splitting.",
    parameters: [
      { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 120 } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    ],
    responses: { 200: { description: "Treffer", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: ProductSchemaJson } } } } } } },
  },
};

paths["/v1/products/{id}"] = {
  get: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt lesen", operationId: "getProduct",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^sku_" } }],
    responses: { 200: { description: "Product", content: { "application/json": { schema: ProductSchemaJson } } }, 404: PROBLEM_RESPONSE("Nicht gefunden") },
  },
  patch: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt ändern", operationId: "patchProduct",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^sku_" } }, IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: ProductPatchJson } } },
    responses: { 200: { description: "Updated", content: { "application/json": { schema: ProductSchemaJson } } } },
  },
  delete: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt Soft-Delete", operationId: "deleteProduct",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^sku_" } }],
    responses: { 204: { description: "Deleted" } },
  },
};

paths["/v1/products/import"] = {
  post: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "CSV-Import (Streaming)",
    description: "Erwartet Header `sku_code,name,tax_class,is_perishable,min_order_qty,packaging_units,attributes`. Streaming-Verarbeitung in 50er-Batches mit `INSERT OR IGNORE`.",
    operationId: "importProductsCsv",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "text/csv": { schema: { type: "string" } } } },
    responses: {
      200: { description: "Import-Report", content: { "application/json": { schema: {
        type: "object",
        required: ["imported_ok", "imported_failed", "duration_ms"],
        properties: {
          imported_ok: { type: "integer" },
          imported_failed: { type: "array", items: { type: "object", properties: { line: { type: "integer" }, code: { type: "string" }, detail: { type: "string" } } } },
          duration_ms: { type: "integer" },
        },
      } } } },
    },
  },
};

paths["/v1/products/{id}/images"] = {
  post: {
    tags: ["products"], security: TENANT_AUTH,
    summary: "Produkt-Bild Upload (R2)",
    description: "Max 5 MB. Pfad: `{tenant_id}/products/{sku_id}/{sha256}.{ext}`. CF-Image-Resizing on-demand via Query-Params.",
    operationId: "uploadProductImage",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^sku_" } }, IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } } } },
    responses: {
      201: { description: "Stored", content: { "application/json": { schema: { type: "object", properties: { image_id: { type: "string" }, r2_key: { type: "string" }, bytes: { type: "integer" } } } } } },
      413: PROBLEM_RESPONSE("Datei zu gross"),
    },
  },
};

// PRICING
paths["/v1/pricing/quote"] = {
  post: {
    tags: ["pricing"], security: TENANT_AUTH,
    summary: "Pricing-Quote",
    description: "Pure-Funktion-Engine: customer_special > qty_break > list_item. Banker's Rounding für %-Rabatte. Output deterministisch.",
    operationId: "pricingQuote",
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["customer_id", "sku_id", "qty"],
      properties: {
        customer_id: { type: "string", pattern: "^cust_" },
        sku_id: { type: "string", pattern: "^sku_" },
        qty: { type: "integer", minimum: 1 },
        on_date: { type: "string", format: "date-time" },
      },
    } } } },
    responses: {
      200: { description: "Quote", content: { "application/json": { schema: PricingResultJson } } },
      422: PROBLEM_RESPONSE("Kein Preis hinterlegt"),
    },
  },
};

// STOCK
paths["/v1/stock/movements"] = {
  post: {
    tags: ["stock"], security: TENANT_AUTH,
    summary: "Manuelle Stock-Anpassung",
    description: "qty_delta>0 = Wareneingang/Korrektur, <0 = Schwund/Bruch. Schreibt stock_movements + DO.adjust.",
    operationId: "adjustStock",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["warehouse_id", "sku_id", "qty_delta"],
      properties: {
        warehouse_id: { type: "string", pattern: "^wh_" },
        sku_id: { type: "string", pattern: "^sku_" },
        qty_delta: { type: "integer" },
        reason: { type: "string", maxLength: 200 },
      },
    } } } },
    responses: {
      201: { description: "Applied", content: { "application/json": { schema: { allOf: [StockStateJson, { type: "object", properties: { applied: { type: "integer" } } }] } } } },
    },
  },
};

paths["/v1/stock/state"] = {
  get: {
    tags: ["stock"], security: TENANT_AUTH,
    summary: "Bestand abfragen",
    operationId: "getStockState",
    parameters: [
      { name: "warehouse_id", in: "query", required: true, schema: { type: "string", pattern: "^wh_" } },
      { name: "sku_id", in: "query", required: true, schema: { type: "string", pattern: "^sku_" } },
    ],
    responses: { 200: { description: "State", content: { "application/json": { schema: StockStateJson } } } },
  },
};

paths["/v1/stock/batches"] = {
  post: {
    tags: ["batches"], security: TENANT_AUTH,
    summary: "Wareneingang (Batch mit MHD)",
    description: "Erzeugt stock_batches-Eintrag und erhöht DO-Counter. FEFO-Recheck-Cron markiert abgelaufene Batches.",
    operationId: "receiveBatch",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["warehouse_id", "sku_id", "qty"],
      properties: {
        warehouse_id: { type: "string", pattern: "^wh_" },
        sku_id: { type: "string", pattern: "^sku_" },
        qty: { type: "integer", minimum: 1 },
        mhd: { type: "string", format: "date" },
        notes: { type: "string", maxLength: 500 },
      },
    } } } },
    responses: { 201: { description: "Batch angelegt", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } } } } },
  },
  get: {
    tags: ["batches"], security: TENANT_AUTH,
    summary: "Aktive Batches einer SKU", operationId: "listBatches",
    parameters: [{ name: "sku_id", in: "query", required: true, schema: { type: "string", pattern: "^sku_" } }],
    responses: { 200: { description: "Liste", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } } } } } } },
  },
};

// ORDERS
paths["/v1/orders"] = {
  post: {
    tags: ["orders"], security: TENANT_AUTH,
    summary: "Order anlegen (Draft)",
    description: "Auto-Chain: resolve (Pricing+Tax) → validate_gates (credit/min/vat) → reserve_stock (DO-Reserve) → await_confirmation. Doc kommt im Zustand 'awaiting_confirmation' zurück, oder als 201 mit 'on_hold' und Grund in issues.blocking bei Gate-Failure oder zu wenig Bestand (GH-FEFO-001 / GH-STOCK-001); dann ist nichts reserviert.",
    operationId: "createOrder",
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: CreateOrderRequestJson } } },
    responses: {
      201: { description: "Order angelegt", content: { "application/json": { schema: { type: "object", properties: { doc: OrderDocJson, etag: { type: "string" }, steps_executed: { type: "integer" } } } } } },
      404: PROBLEM_RESPONSE("Customer nicht gefunden"),
      422: PROBLEM_RESPONSE("Pricing/Tax/Stock-Failure"),
    },
  },
  get: {
    tags: ["orders"], security: TENANT_AUTH,
    summary: "Orders listen (paginiert)", operationId: "listOrders",
    parameters: [
      { name: "state", in: "query", required: false, schema: OrderStateJson },
      { name: "customer_id", in: "query", required: false, schema: { type: "string" } },
      { name: "created_after", in: "query", required: false, schema: { type: "string", format: "date-time" } },
      { name: "created_before", in: "query", required: false, schema: { type: "string", format: "date-time" } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
    ],
    responses: { 200: { description: "Liste", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array" }, next_cursor: { type: ["string", "null"] } } } } } } },
  },
};

paths["/v1/orders/{id}"] = {
  get: {
    tags: ["orders"], security: TENANT_AUTH,
    summary: "Order lesen", operationId: "getOrder",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^ord_" } }],
    responses: { 200: { description: "Order", content: { "application/json": { schema: { type: "object", properties: { doc: OrderDocJson, etag: { type: "string" } } } } } }, 404: PROBLEM_RESPONSE("Nicht gefunden") },
  },
};

paths["/v1/orders/{id}/confirm"] = {
  post: {
    tags: ["orders"], security: TENANT_AUTH,
    summary: "Order bestätigen",
    description: "Auto-Chain: commit_stock → emit_event(order.confirmed.v1) → generate_invoice. Erfordert State 'awaiting_confirmation'. Idempotent via X-Idempotency-Key.",
    operationId: "confirmOrder",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^ord_" } }, IDEMPOTENCY_HEADER],
    responses: { 200: { description: "Confirmed", content: { "application/json": { schema: { type: "object", properties: { doc: OrderDocJson, etag: { type: "string" } } } } } }, 409: PROBLEM_RESPONSE("Falscher State") },
  },
};

paths["/v1/orders/{id}/cancel"] = {
  post: {
    tags: ["orders"], security: TENANT_AUTH,
    summary: "Order stornieren",
    description: "Auto-Chain: release_stock → emit_event(order.cancelled.v1).",
    operationId: "cancelOrder",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^ord_" } }, IDEMPOTENCY_HEADER],
    requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string", maxLength: 200 } } } } } },
    responses: { 200: { description: "Cancelled", content: { "application/json": { schema: { type: "object", properties: { doc: OrderDocJson, etag: { type: "string" } } } } } }, 409: PROBLEM_RESPONSE("Final-State") },
  },
};

// RETURNS AND COMPLAINTS
const returnRef = toSchema(ReturnRef);
const returnPath = (...names: string[]) => names.map((name) => ({
  name, in: "path", required: true, schema: returnRef,
}));
const returnAfter = { name: "after", in: "query", schema: returnRef };
const returnBody = (schema: z.ZodType) => ({
  required: true, content: { "application/json": { schema: toSchema(schema) } },
});
const returnResult = {
  type: "object", required: ["id", "version"],
  properties: { id: returnRef, version: { type: "integer", minimum: 1 } },
};
const returnView = {
  ...returnResult,
  required: [...returnResult.required, "order_id", "kind", "lines"],
  properties: {
    ...returnResult.properties, order_id: returnRef, kind: { type: "string", enum: ["return", "complaint"] },
    lines: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};
const returnList = (items: JsonSchema) => ({
  type: "object", required: ["items", "next"],
  properties: { items: { type: "array", items }, next: { type: ["string", "null"] } },
});
const deliveryPosition = {
  type: "object", required: ["delivery_line_id", "order_line_no", "qty"],
  properties: { delivery_line_id: returnRef, order_line_no: { type: "integer" }, qty: { type: "integer" } },
};
const returnsResponses = {
  400: PROBLEM_RESPONSE("Ungültige Eingabe"),
  401: PROBLEM_RESPONSE("Authentifizierung fehlt"),
  403: PROBLEM_RESPONSE("Fehlende Berechtigung"),
  404: PROBLEM_RESPONSE("Fall oder Position nicht sichtbar"),
  409: PROBLEM_RESPONSE("Konflikt bei Version, Menge, Status oder Befehls-ID"),
};
const returnCommandResponses = {
  ...returnsResponses,
  ...Object.fromEntries([JSON_RESPONSE("Befehl gespeichert", returnResult)]),
  503: PROBLEM_RESPONSE("Bestätigung fehlt. Denselben Befehl erneut senden."),
};
for (const view of [
  { prefix: "/v1/orders", security: TENANT_AUTH, tag: "B2B", headers: [] },
  { prefix: "/v1/customer/orders", security: CUSTOMER_AUTH, tag: "Customer", headers: CLIENT_HEADERS },
]) {
  const { prefix, security, tag, headers } = view;
  const responses = tag === "Customer" ? {
    ...returnsResponses, 426: PROBLEM_RESPONSE("Client-Update erforderlich"),
  } : returnsResponses;
  paths[`${prefix}/{orderId}/return-deliveries`] = {
    get: {
      security, summary: "Gelieferte Bestellpositionen lesen", operationId: `list${tag}ReturnDeliveries`,
      parameters: [...headers, ...returnPath("orderId"), returnAfter],
      responses: { ...responses, ...Object.fromEntries([JSON_RESPONSE("Lieferpositionen", returnList(deliveryPosition))]) },
    },
  };
  paths[`${prefix}/{orderId}/returns`] = {
    get: {
      security, summary: "Retouren und Reklamationen einer Bestellung auflisten", operationId: `list${tag}Returns`,
      parameters: [...headers, ...returnPath("orderId"), returnAfter],
      responses: { ...responses, ...Object.fromEntries([JSON_RESPONSE("Retourenfälle", returnList(returnView))]) },
    },
    post: {
      security, summary: "Retoure oder Reklamation melden", operationId: `create${tag}Return`,
      parameters: [...headers, ...returnPath("orderId"), IDEMPOTENCY_HEADER], requestBody: returnBody(CreateReturnInput),
      responses: { ...responses, ...Object.fromEntries([JSON_RESPONSE("Fall angelegt", returnResult, 201)]) },
    },
  };
  paths[`${prefix}/{orderId}/returns/{caseId}`] = {
    get: {
      security, summary: "Aktuellen Fallstand lesen", operationId: `get${tag}Return`,
      parameters: [...headers, ...returnPath("orderId", "caseId")],
      responses: { ...responses, ...Object.fromEntries([JSON_RESPONSE("Retourenfall", returnView)]) },
    },
  };
}
paths["/v1/orders/{orderId}/return-deliveries"]!.post = {
  security: TENANT_AUTH, summary: "Gelieferte Mengen und Beschaffungszuordnung melden", operationId: "recordReturnDeliveries",
  parameters: returnPath("orderId"), requestBody: returnBody(DeliveryInput),
  responses: {
    ...returnsResponses, ...Object.fromEntries([JSON_RESPONSE("Lieferpositionen gespeichert", {
      type: "object", properties: { positions: { type: "array", items: returnRef } },
    }, 201)]),
  },
};
paths["/v1/orders/{orderId}/returns/{caseId}/commands"] = {
  post: {
    security: TENANT_AUTH, summary: "Retourenfall bearbeiten", operationId: "applyB2BReturnCommand",
    parameters: returnPath("orderId", "caseId"), requestBody: returnBody(ReturnCommandInput), responses: returnCommandResponses,
  },
};
paths["/v1/suppliers/return-inbox"] = {
  get: {
    security: TENANT_AUTH, summary: "Empfangene Lieferantenübergaben lesen", operationId: "listSupplierReturnInbox",
    parameters: [returnAfter],
    responses: { ...returnsResponses, ...Object.fromEntries([JSON_RESPONSE("Übergaben", returnList(toSchema(SupplierHandoff)))]) },
  },
};
paths["/v1/suppliers/{ownerTenantId}/orders/{orderId}/returns/{caseId}"] = {
  get: {
    security: TENANT_AUTH, summary: "Zugewiesene Lieferantenpositionen lesen", operationId: "getSupplierReturn",
    parameters: returnPath("ownerTenantId", "orderId", "caseId"),
    responses: { ...returnsResponses, ...Object.fromEntries([JSON_RESPONSE("Zugewiesene Positionen", returnView)]) },
  },
};
paths["/v1/suppliers/{ownerTenantId}/orders/{orderId}/returns/{caseId}/commands"] = {
  post: {
    security: TENANT_AUTH, summary: "Zugewiesene Lieferantenposition bearbeiten", operationId: "applySupplierReturnCommand",
    parameters: returnPath("ownerTenantId", "orderId", "caseId"), requestBody: returnBody(ReturnCommandInput),
    responses: returnCommandResponses,
  },
};

// INVOICES
paths["/v1/invoices/{id}"] = {
  get: {
    tags: ["invoices"], security: TENANT_AUTH,
    summary: "Invoice-PDF abrufen",
    description: "Streamt das PDF aus R2. Content-Type=application/pdf. Plan-Revision: signed-URL mit 7d/90d-TTL.",
    operationId: "getInvoice",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^inv_" } }],
    responses: {
      200: { description: "PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
      404: PROBLEM_RESPONSE("Nicht gefunden / nicht generiert"),
    },
  },
};

// WEBHOOKS
paths["/v1/webhooks"] = {
  post: {
    tags: ["webhooks"], security: TENANT_AUTH,
    summary: "Webhook-Subscription anlegen",
    description: "signing_secret wird einmalig zurückgegeben — sicher speichern. Headers bei Delivery: X-Grosshandel-Event/Signature/Idempotency-Key/Delivery-Attempt/Event-Version.",
    operationId: "createWebhook",
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, topic_filter: { type: "string", default: "*" }, description: { type: "string", maxLength: 200 } } } } } },
    responses: { 201: { description: "Created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, topic_filter: { type: "string" }, signing_secret: { type: "string" }, active: { type: "boolean" } } } } } } },
  },
  get: {
    tags: ["webhooks"], security: TENANT_AUTH,
    summary: "Webhook-Subscriptions listen", operationId: "listWebhooks",
    responses: { 200: { description: "Liste", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array" } } } } } } },
  },
};

paths["/v1/webhooks/{id}"] = {
  delete: {
    tags: ["webhooks"], security: TENANT_AUTH,
    summary: "Webhook deaktivieren", operationId: "deleteWebhook",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { 204: { description: "Deactivated" } },
  },
};

paths["/v1/dsgvo/pseudonymize-customer"] = {
  post: {
    tags: ["customers"], security: TENANT_AUTH,
    summary: "DSGVO: Customer pseudonymisieren (Recht auf Vergessenwerden)",
    description: "Ersetzt PII-Felder (name, email, phone, addresses) durch sha256-Hash-Tags. Customer-ID, tenant-Beziehung und Bestellungen bleiben referenziert für 10-Jahre-Aufbewahrungspflicht. Setzt deleted_at + pseudonymized_at.",
    operationId: "pseudonymizeCustomer",
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["customer_id", "reason"],
      properties: {
        customer_id: { type: "string", pattern: "^cust_" },
        reason: { type: "string", minLength: 1, maxLength: 500, description: "DSGVO-Antrag-ID, Datum, Bearbeiter" },
      },
    } } } },
    responses: {
      200: { description: "Pseudonymized", content: { "application/json": { schema: { type: "object", properties: { customer_id: { type: "string" }, pseudonymized_at: { type: "string", format: "date-time" }, fields_replaced: { type: "array", items: { type: "string" } } } } } } },
      404: PROBLEM_RESPONSE("Customer nicht gefunden"),
    },
  },
};

// CUSTOMER SELF
paths["/v1/customer/devices"] = {
  post: {
    tags: ["customer-self"], security: CUSTOMER_AUTH,
    summary: "Device für Push-Notifications registrieren",
    operationId: "registerDevice",
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["platform", "push_token"],
      properties: {
        platform: { type: "string", enum: ["ios", "android", "web"] },
        push_token: { type: "string", minLength: 20, maxLength: 400 },
        app_version: { type: "string" }, language: { type: "string" }, timezone: { type: "string" },
      },
    } } } },
    responses: { 201: { description: "Registered" }, 200: { description: "Updated existing token" } },
  },
};

// ---------- Kunden-API (mobile App, Kunden-JWT) ----------
// Tenant und Kunde kommen aus dem Token. Bestellungen verlassen den Server nur
// als Kundenansicht (Build-Plan G3): ohne plan/audit/gates_log/Lager/Reservierung.

const CUSTOMER_ORDER_VIEW: JsonSchema = {
  type: "object",
  required: ["id", "state", "currency", "lines", "totals", "invoice", "allowed_actions", "blocking"],
  properties: {
    id: { type: "string", pattern: "^ord_" },
    revision: { type: "string", description: "Revision des geprüften Auftrags für die Bestätigung" },
    reservation_expires_at: { type: "string", format: "date-time" },
    state: { type: "string", enum: ["draft", "resolving", "awaiting_confirmation", "confirmed", "shipped", "invoiced", "paid", "cancelled", "on_hold"] },
    created_at: { type: ["string", "null"], format: "date-time" },
    currency: { type: "string" },
    lines: { type: "array", items: { type: "object", properties: {
      line_no: { type: "integer" }, sku_id: { type: "string" }, name: { type: ["string", "null"] }, qty: { type: "integer" },
      unit_price_cents: { type: ["integer", "null"] }, tax_rate_pct: { type: ["number", "null"] }, line_total_cents: { type: ["integer", "null"] },
    } } },
    totals: { type: "object", properties: { subtotal_cents: { type: "integer" }, tax_cents: { type: "integer" }, total_cents: { type: "integer" } } },
    invoice: { type: ["object", "null"], properties: { number: { type: "string" }, available: { type: "boolean" } } },
    allowed_actions: { type: "array", items: { type: "string", enum: ["confirm", "cancel"] }, description: "Was der Kunde jetzt tun kann. Bestätigte Bestellungen storniert nur der Händler." },
    blocking: { type: "array", items: { type: "object", properties: { code: { type: "string" }, detail: { type: "string" }, line_no: { type: "integer" } } }, description: "Gründe bei state=on_hold, z.B. GH-FEFO-001 (zu wenig Bestand mit Restlaufzeit)." },
  },
};

const CUSTOMER_PRODUCT: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, sku_code: { type: "string" }, name: { type: "string" }, description: { type: ["string", "null"] },
    min_order_qty: { type: "integer" }, packaging_units: { type: "array" }, attributes: { type: "object" }, image_url: { type: ["string", "null"] },
  },
};

const CUST_COMMON: { tags: string[]; security: typeof CUSTOMER_AUTH } = { tags: ["customer-self"], security: CUSTOMER_AUTH };
const ORDER_ID_PARAM = { name: "id", in: "path" as const, required: true, schema: { type: "string", pattern: "^ord_" } };
const CHECKOUT_OPERATION = { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" };
const CUST_ERRORS = {
  400: PROBLEM_RESPONSE("GH-INPUT-001 (auch: X-Client-Version/X-Client-Platform fehlen)"),
  401: PROBLEM_RESPONSE("Token fehlt, ungültig oder abgelaufen (GH-AUTH-002/005)"),
  403: PROBLEM_RESPONSE("Scope reicht nicht (GH-AUTH-004)"),
  426: PROBLEM_RESPONSE("Client-Version zu alt (GH-CLIENT-001)"),
};

paths["/v1/public/product-images/{id}"] = {
  get: { tags: ["public"], summary: "Produktbild (öffentlich, unveränderlich cachebar). Die URL kommt als image_url aus der Kunden-API.", operationId: "getProductImage",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { 200: { description: "Bild", content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } } } },
      404: PROBLEM_RESPONSE("GH-PROD-001") } },
};

paths["/v1/customer/me"] = {
  get: { ...CUST_COMMON, summary: "Eigenes Konto und Händler", operationId: "customerMe", parameters: [...CLIENT_HEADERS],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Konto", { type: "object", properties: {
      customer: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: ["string", "null"] }, country: { type: "string" }, vat_id: { type: ["string", "null"] } } },
      merchant: { type: "object", properties: { name: { type: ["string", "null"] }, country: { type: ["string", "null"] }, currency: { type: ["string", "null"] } } },
    } })]), ...CUST_ERRORS } },
};

paths["/v1/customer/products"] = {
  get: { ...CUST_COMMON, summary: "Katalog (Suche mit q, sonst Liste mit Cursor)", operationId: "customerListProducts",
    parameters: [...CLIENT_HEADERS,
      { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 120 } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } }],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Artikel", { type: "object", properties: { items: { type: "array", items: CUSTOMER_PRODUCT }, next_cursor: { type: ["string", "null"] } } })]), ...CUST_ERRORS } },
};

paths["/v1/customer/products/{id}"] = {
  get: { ...CUST_COMMON, summary: "Ein Artikel", operationId: "customerGetProduct",
    parameters: [...CLIENT_HEADERS, { name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Artikel", CUSTOMER_PRODUCT)]), 404: PROBLEM_RESPONSE("GH-PROD-001"), ...CUST_ERRORS } },
};

paths["/v1/customer/quotes"] = {
  post: { ...CUST_COMMON, summary: "Preisvorschau für den eigenen Kunden (netto)", operationId: "customerQuote", parameters: [...CLIENT_HEADERS],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["sku_id", "qty"], properties: { sku_id: { type: "string" }, qty: { type: "integer", minimum: 1, maximum: 100000 } } } } } },
    responses: { ...Object.fromEntries([JSON_RESPONSE("Preis", { type: "object", properties: {
      sku_id: { type: "string" }, name: { type: "string" }, qty: { type: "integer" }, unit_price_cents: { type: "integer" }, total_cents: { type: "integer" },
      currency: { type: "string" }, net: { type: "boolean" }, checked_at: { type: "string", format: "date-time" },
    } })]), 404: PROBLEM_RESPONSE("GH-PROD-001"), ...CUST_ERRORS } },
};

paths["/v1/customer/orders"] = {
  get: { ...CUST_COMMON, summary: "Eigene Aufträge (neueste zuerst)", operationId: "customerListOrders",
    parameters: [...CLIENT_HEADERS,
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } }],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Aufträge", { type: "object", properties: {
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, state: { type: "string" }, total_cents: { type: "integer" }, currency: { type: "string" }, created_at: { type: "string" } } } },
      next_cursor: { type: ["string", "null"] },
    } })]), ...CUST_ERRORS } },
  post: { ...CUST_COMMON, summary: "Entwurf anlegen: Preis, Steuer, Reservierung. 201 mit awaiting_confirmation oder on_hold (blocking nennt den Grund).", operationId: "customerCreateOrder",
    parameters: [...CLIENT_HEADERS, IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["lines"], properties: { operation_id: CHECKOUT_OPERATION, lines: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["sku_id", "qty"], properties: { sku_id: { type: "string" }, qty: { type: "integer", minimum: 1 } } } } } } } } },
    responses: { ...Object.fromEntries([JSON_RESPONSE("Entwurf", CUSTOMER_ORDER_VIEW, 201)]), 409: PROBLEM_RESPONSE("GH-IDEMP-001"), ...CUST_ERRORS } },
};

paths["/v1/customer/orders/{id}"] = {
  get: { ...CUST_COMMON, summary: "Eigener Auftrag (fremde sind 404)", operationId: "customerGetOrder", parameters: [...CLIENT_HEADERS, ORDER_ID_PARAM],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Auftrag", CUSTOMER_ORDER_VIEW)]), 404: PROBLEM_RESPONSE("GH-ORDER-001"), ...CUST_ERRORS } },
};

paths["/v1/customer/orders/{id}/confirm"] = {
  post: { ...CUST_COMMON, summary: "Entwurf bestätigen: Bestand verbuchen, Event, Rechnung", operationId: "customerConfirmOrder", parameters: [...CLIENT_HEADERS, ORDER_ID_PARAM, IDEMPOTENCY_HEADER],
    requestBody: { required: false, content: { "application/json": { schema: {
      type: "object", properties: { operation_id: CHECKOUT_OPERATION, expected_revision: { type: "string", minLength: 1, maxLength: 128 } },
      dependentRequired: { operation_id: ["expected_revision"] },
    } } } },
    responses: { ...Object.fromEntries([JSON_RESPONSE("Bestätigt", CUSTOMER_ORDER_VIEW)]), 404: PROBLEM_RESPONSE("GH-ORDER-001"),
      409: PROBLEM_RESPONSE("GH-STATE-001, GH-ORDER-002 oder GH-IDEMP-001"), 410: PROBLEM_RESPONSE("GH-STOCK-002 (Reservierung abgelaufen)"), ...CUST_ERRORS } },
};

paths["/v1/customer/orders/{id}/cancel"] = {
  post: { ...CUST_COMMON, summary: "Entwurf oder angehaltene Bestellung stornieren (bestätigte nur über den Händler)", operationId: "customerCancelOrder", parameters: [...CLIENT_HEADERS, ORDER_ID_PARAM, IDEMPOTENCY_HEADER],
    requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { operation_id: CHECKOUT_OPERATION, reason: { type: "string", maxLength: 200 } } } } } },
    responses: { ...Object.fromEntries([JSON_RESPONSE("Storniert", CUSTOMER_ORDER_VIEW)]), 404: PROBLEM_RESPONSE("GH-ORDER-001"), 409: PROBLEM_RESPONSE("GH-STATE-001"), ...CUST_ERRORS } },
};

paths["/v1/customer/order-operations/{id}"] = {
  get: { ...CUST_COMMON, summary: "Bekannten Bestellvorgang nach Antwortverlust prüfen", operationId: "customerGetOrderOperation",
    parameters: [...CLIENT_HEADERS, { name: "id", in: "path", required: true, schema: CHECKOUT_OPERATION }],
    responses: { ...Object.fromEntries([JSON_RESPONSE("Vorgangsstatus", { type: "object",
      required: ["operation_id", "state", "repeat_allowed"],
      properties: {
        operation_id: CHECKOUT_OPERATION,
        state: { type: "string", enum: ["not_recorded", "pending", "completed"] },
        repeat_allowed: { type: "boolean" },
        order: CUSTOMER_ORDER_VIEW,
      },
    })]), ...CUST_ERRORS } },
};

paths["/v1/customer/orders/{id}/invoice"] = {
  get: { ...CUST_COMMON, summary: "Rechnungs-PDF des eigenen Auftrags", operationId: "customerGetInvoice", parameters: [...CLIENT_HEADERS, ORDER_ID_PARAM],
    responses: { 200: { description: "PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
      404: PROBLEM_RESPONSE("GH-ORDER-001 (nicht eigener Auftrag) oder GH-PDF-003 (noch keine Rechnung)"),
      500: PROBLEM_RESPONSE("GH-PDF-001 (Rechnung vermerkt, Datei fehlt)"), ...CUST_ERRORS } },
};

paths["/v1/customer/devices/{id}"] = {
  delete: {
    tags: ["customer-self"], security: CUSTOMER_AUTH,
    summary: "Device deaktivieren", operationId: "deleteDevice",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { 204: { description: "Deactivated" } },
  },
};

// MCP
paths["/mcp"] = {
  post: {
    tags: ["mcp"],
    summary: "MCP-Endpoint (JSON-RPC 2.0)",
    description: "AI-Agent-Endpoint. Methoden: `initialize` (öffentlich), `tools/list` und `tools/call` (auth via Bearer JWT). 8 Tools: search_products, get_price_quote, list_customers, create_order_draft, confirm_order, cancel_order, get_order, list_orders. Two-Tool-Pattern: create_order_draft + confirm_order müssen separat aufgerufen werden — kein One-Shot-Commit.",
    operationId: "mcpJsonRpc",
    security: [{}, { customer_jwt: [] }],
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object",
      required: ["jsonrpc", "method"],
      properties: {
        jsonrpc: { type: "string", enum: ["2.0"] },
        id: { oneOf: [{ type: "string" }, { type: "integer" }] },
        method: { type: "string", enum: ["initialize", "tools/list", "tools/call"] },
        params: { type: "object" },
      },
    } } } },
    responses: {
      200: { description: "JSON-RPC Result oder Error", content: { "application/json": { schema: {
        type: "object",
        required: ["jsonrpc"],
        properties: { jsonrpc: { type: "string" }, id: {}, result: {}, error: { type: "object" } },
      } } } },
    },
  },
};

// ---------- Document ----------

const supplierBase = "/v1/suppliers/floriday";
const supplierErrors = {
  400: PROBLEM_RESPONSE("Ungültige Eingabe"), 401: PROBLEM_RESPONSE("Authentifizierung fehlgeschlagen"),
  404: PROBLEM_RESPONSE("Angebot oder Bestellung nicht gefunden"), 409: PROBLEM_RESPONSE("Angebot oder Bestellung verändert"),
  502: PROBLEM_RESPONSE("Fehler beim Anbieter"), 503: PROBLEM_RESPONSE("Anbindung deaktiviert oder nicht konfiguriert"),
};
const supplierOperation = (operationId: string, summary: string, schema: JsonSchema, status = 200): Operation => ({
  tags: ["suppliers"], security: TENANT_AUTH, operationId, summary,
  responses: { ...Object.fromEntries([JSON_RESPONSE(summary, schema, status)]), ...supplierErrors },
});
const snapshotPath = "/v1/suppliers/imports/{source}";
const snapshotSourceParameter = { name: "source", in: "path", required: true, schema: toSchema(snapshotSource) };
paths[snapshotPath] = {
  post: {
    ...supplierOperation("importSupplierSnapshot", "Lieferantenangebote importieren", {
      type: "object", required: ["revision", "imported", "applied"], properties: {
        revision: { type: "integer" }, imported: { type: "integer" }, applied: { type: "boolean" },
      },
    }),
    parameters: [snapshotSourceParameter],
    requestBody: { required: true, content: { "application/json": { schema: toSchema(snapshotInput) } } },
  },
  get: {
    ...supplierOperation("listSupplierSnapshot", "Importierte Lieferantenangebote lesen", {
      type: "object", required: ["revision", "expires_at", "items", "next_after"], properties: {
        revision: { type: "integer" }, expires_at: { type: "string", format: "date-time" },
        items: { type: "array", items: toSchema(snapshotOffer) }, next_after: { type: ["string", "null"] },
      },
    }),
    parameters: [snapshotSourceParameter,
      { name: "after", in: "query", schema: toSchema(snapshotSku) },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
    ],
  },
};
paths[supplierBase] = {
  get: supplierOperation("getFloridayConnection", "Status der Floriday-Anbindung", {
    type: "object", required: ["enabled", "environment", "scheduled", "ordering"], properties: {
      enabled: { type: "boolean" }, environment: { enum: ["staging", "production", null] },
      scheduled: { type: "boolean" }, ordering: { type: "boolean" },
    },
  }),
};
paths[supplierBase + "/sync"] = {
  post: supplierOperation("syncFloriday", "Katalog und Angebote seitenweise synchronisieren", {
    type: "object", required: ["streams"], properties: {
      streams: { type: "array", items: { type: "object", required: ["stream", "sequence", "processed", "caught_up"], properties: {
        stream: { enum: ["catalog", "offers"] }, sequence: { type: "integer" },
        processed: { type: "integer" }, caught_up: { type: "boolean" },
      } } },
    },
  }),
};
for (const stream of ["catalog", "offers"] as const) {
  paths[supplierBase + "/" + stream] = {
    get: {
      ...supplierOperation(stream === "catalog" ? "listFloridayCatalog" : "listFloridayOffers", "Floriday " + stream, {
        type: "object", required: ["items", "next_after"], properties: {
          items: { type: "array", items: { type: "object", additionalProperties: true } },
          next_after: { type: ["string", "null"], format: "uuid" },
        },
      }),
      parameters: [
        { name: "after", in: "query", schema: { type: "string", format: "uuid" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      ],
    },
  };
}
const supplierOrderSchema = {
  type: "object", required: ["id", "offer_id", "status", "input", "created_at", "updated_at"],
  properties: {
    id: { type: "string", format: "uuid" }, offer_id: { type: "string", format: "uuid" },
    status: { enum: ["draft", "submitting", "unknown", "submitted", "rejected"] },
    provider_status: { type: ["string", "null"] }, provider_sequence: { type: ["integer", "null"] },
    last_checked_at: { type: ["string", "null"], format: "date-time" },
    created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
    input: toSchema(purchaseInput),
  },
};
paths[supplierBase + "/purchase-orders"] = {
  post: {
    ...supplierOperation("createFloridayPurchaseOrder", "Einkaufsbestellung als Entwurf erstellen", supplierOrderSchema, 201),
    requestBody: { required: true, content: { "application/json": { schema: toSchema(purchaseInput) } } },
  },
};
const supplierOrderParameters = [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }];
paths[supplierBase + "/purchase-orders/{id}"] = {
  get: { ...supplierOperation("getFloridayPurchaseOrder", "Einkaufsbestellung lesen", supplierOrderSchema), parameters: supplierOrderParameters },
};
paths[supplierBase + "/purchase-orders/{id}/submit"] = {
  post: { ...supplierOperation("submitFloridayPurchaseOrder", "Einkaufsbestellung an Floriday senden", supplierOrderSchema), parameters: supplierOrderParameters },
};
paths[supplierBase + "/purchase-orders/{id}/reconcile"] = {
  post: { ...supplierOperation("reconcileFloridayPurchaseOrder", "Bestellstatus mit Floriday abgleichen", supplierOrderSchema), parameters: supplierOrderParameters },
};

const komanderBase = "/v1/suppliers/komander";
const optionalQuery = (name: string, schema: JsonSchema = { type: "string" }) => ({ name, in: "query", schema });
paths[komanderBase + "/products"] = {
  get: {
    ...supplierOperation("searchKomanderProducts", "Blumensträuße bei Komander suchen", {
      type: "object", required: ["products"], additionalProperties: true,
      properties: { products: { type: "array", items: { type: "object", additionalProperties: true } } },
    }),
    parameters: [
      ...["occasion", "color", "flower_type", "style"].map((name) => optionalQuery(name)),
      ...["minPrice", "maxPrice"].map((name) => optionalQuery(name, { type: "number", minimum: 0 })),
      optionalQuery("limit", { type: "integer", minimum: 1, maximum: 50 }),
      optionalQuery("offset", { type: "integer", minimum: 0 }),
    ],
  },
};
paths[komanderBase + "/availability"] = {
  get: {
    ...supplierOperation("checkKomanderAvailability", "Lieferbarkeit bei Komander prüfen", {
      type: "object", required: ["available"], additionalProperties: true, properties: { available: { type: "boolean" } },
    }),
    parameters: [
      { ...optionalQuery("date", { type: "string", format: "date" }), required: true },
      optionalQuery("postalCode", { type: "string", pattern: "^[0-9]{5}$" }),
    ],
  },
};
paths[komanderBase + "/checkout"] = {
  post: {
    ...supplierOperation("createKomanderCheckout", "Komander-Warenkorb und Checkout-Link vorbereiten", {
      type: "object", required: ["cart_id", "checkout_url"],
      properties: { cart_id: { type: "string" }, checkout_url: { type: "string", format: "uri" } },
    }, 201),
    parameters: [IDEMPOTENCY_HEADER],
    requestBody: { required: true, content: { "application/json": { schema: toSchema(komanderCheckout) } } },
  },
};

const fleuropBase = "/v1/suppliers/fleurop-nl";
const fleuropPaging = [
  optionalQuery("offset", { type: "integer", minimum: 1, default: 1 }),
  optionalQuery("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }),
];
const fleuropMemberId = optionalQuery("member_id", { type: "integer", minimum: 1, maximum: 99999 });
const fleuropZip = { ...optionalQuery("zipcode", { type: "string" }), required: true };
const fleuropJsonPage = {
  type: "object", required: ["data"], properties: {
    data: { type: "array", items: { type: "object", additionalProperties: true } },
    currentPage: { type: "integer" }, pageCount: { type: "integer" },
    pageSize: { type: "integer" }, rowCount: { type: "integer" },
  },
};
const supplierDispatchSchema = {
  type: "object", required: ["id", "remote_id", "status"], properties: {
    id: { type: "string", format: "uuid" }, remote_id: { type: ["string", "null"] },
    status: { enum: ["sending", "submitted", "unknown", "rejected"] },
  },
};
paths[fleuropBase] = {
  get: supplierOperation("getFleuropNlConnection", "Status der Fleurop-NL-Anbindung", {
    type: "object", required: ["enabled", "ordering"], properties: {
      enabled: { type: "boolean" }, ordering: { type: "boolean" },
    },
  }),
};
paths[fleuropBase + "/products"] = {
  get: {
    ...supplierOperation("listFleuropNlProducts", "Fleurop-NL-B2B-Sortiment lesen", fleuropJsonPage),
    parameters: [...fleuropPaging, fleuropMemberId],
  },
};
paths[fleuropBase + "/availability"] = {
  get: {
    ...supplierOperation("getFleuropNlAvailability", "Zustellende Floristen in den Niederlanden finden", fleuropJsonPage),
    parameters: [
      ...fleuropPaging, fleuropZip,
      { ...optionalQuery("house_number", { type: "integer", minimum: 1 }), required: true },
      { ...optionalQuery("delivery_date", { type: "string", format: "date-time" }), required: true },
      optionalQuery("delivery_time"),
    ],
  },
};
paths[fleuropBase + "/delivery-costs"] = {
  get: {
    ...supplierOperation("getFleuropNlDeliveryCosts", "Fleurop-NL-Lieferkosten lesen", {
      type: "array", items: { type: "object", required: ["costs", "vatDeliveryCosts"], properties: {
        costs: { type: "integer" }, vatDeliveryCosts: { type: "integer" },
      } },
    }),
    parameters: [fleuropZip, { ...fleuropMemberId, required: true }, { ...optionalQuery("house_number"), required: true }],
  },
};
const fleuropPlace = supplierOperation("placeFleuropNlOrder", "Auftrag einmalig an Fleurop NL übermitteln", supplierDispatchSchema);
paths[fleuropBase + "/orders"] = {
  post: {
    ...fleuropPlace,
    responses: { ...fleuropPlace.responses, ...Object.fromEntries([JSON_RESPONSE("Übermittlung läuft", supplierDispatchSchema, 202)]) },
    requestBody: { required: true, content: { "application/json": { schema: toSchema(fleuropOrder) } } },
  },
};
paths[fleuropBase + "/orders/{id}"] = {
  get: {
    ...supplierOperation("getFleuropNlOrder", "Lokalen Fleurop-NL-Auftragsstatus lesen", supplierDispatchSchema),
    parameters: supplierOrderParameters,
  },
};
paths[fleuropBase + "/orders/{id}/reconcile"] = {
  post: {
    ...supplierOperation("reconcileFleuropNlOrder", "Fleurop-NL-Auftrag anhand der Anbieter-ID abgleichen", {
      ...supplierDispatchSchema,
      properties: {
        ...supplierDispatchSchema.properties, order_number: { type: ["integer", "null"] },
        provider_status: { type: ["string", "null"] }, tracking_status: { type: ["string", "null"] },
        delivery_date: { type: ["string", "null"] },
      },
    }),
    parameters: supplierOrderParameters,
    requestBody: { required: true, content: { "application/json": { schema: toSchema(fleuropReconcile) } } },
  },
};

const fsnBase = "/v1/suppliers/flower-shop-network";
paths[fsnBase + "/products/{id}"] = {
  get: {
    ...supplierOperation("getFsnProduct", "Flower-Shop-Network-Produkt nachschlagen", {
      type: "object", required: ["product"], properties: { product: { type: "object", additionalProperties: true } },
    }),
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  },
};
paths[fsnBase + "/florists"] = {
  get: {
    ...supplierOperation("findFsnFlorists", "Zustellende Partnerfloristen suchen", {
      type: "object", required: ["searchResult"], properties: {
        searchResult: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    }),
    parameters: [
      optionalQuery("city"), optionalQuery("state"), optionalQuery("zip"),
      optionalQuery("order_amount_cents", { type: "integer", minimum: 0 }),
    ],
  },
};
const fsnPlace = supplierOperation("placeFsnOrder", "Floristenauftrag einmalig an Flower Shop Network senden", supplierDispatchSchema);
paths[fsnBase + "/orders"] = {
  post: {
    ...fsnPlace,
    responses: { ...fsnPlace.responses, ...Object.fromEntries([JSON_RESPONSE("Übermittlung läuft", supplierDispatchSchema, 202)]) },
    requestBody: { required: true, content: { "application/json": { schema: toSchema(fsnOrderInput) } } },
  },
};
paths[fsnBase + "/orders/{id}"] = {
  get: {
    ...supplierOperation("getFsnOrder", "Flower-Shop-Network-Bestellstatus anzeigen", {
      ...supplierDispatchSchema,
      properties: {
        ...supplierDispatchSchema.properties,
        provider_order: { type: ["object", "null"], additionalProperties: true },
      },
    }),
    parameters: supplierOrderParameters,
  },
};

export interface OpenApiDocOptions {
  worker_version?: string;
  servers?: Array<{ url: string; description?: string }>;
}

export function buildOpenApiDocument(opts: OpenApiDocOptions = {}): JsonSchema {
  return {
    openapi: "3.1.0",
    info: {
      title: "Grosshandel API",
      version: opts.worker_version ?? "0.1.0",
      summary: "Multi-tenant B2B-Grosshandelsplattform (Cloudflare Workers)",
      description:
        "Zwei Auth-Welten:\n" +
        "  - **Tenant-HMAC**: B2B-Backends nutzen `X-Api-Key + X-Signature + X-Timestamp`. " +
        "Signing-String: `METHOD\\nPATH\\nTIMESTAMP\\nSHA256(BODY)`. ±5min Skew.\n" +
        "  - **Customer-JWT**: Mobile/MCP nutzen `Authorization: Bearer <jwt>` aus Magic-Link/OAuth-Flow.\n\n" +
        "Alle Fehler folgen RFC 7807 `application/problem+json` mit Domain-Codes (`GH-AUTH-*`, `GH-ORDER-*`, …).\n" +
        "Idempotency-Layer: jede mutation kann via `X-Idempotency-Key` (24h) wiederholt werden.\n" +
        "Cross-Tenant-Isolation: alle Lookups sind tenant-scoped; Cross-Tenant-Access → 404 (kein Leak).",
      contact: { name: "grosshandel", url: "https://github.com/Netdoc64/p9s0c3ejvc" },
      license: { name: "Proprietary" },
    },
    servers: opts.servers ?? [
      { url: "https://api.grosshandel.app", description: "Production" },
      { url: "https://staging.api.grosshandel.app", description: "Staging" },
      { url: "http://127.0.0.1:8787", description: "Local Dev (wrangler dev)" },
    ],
    tags: [
      { name: "health", description: "Liveness + Version-Probe" },
      { name: "auth", description: "Customer-Auth (Magic-Link + OAuth 2.1 + PKCE)" },
      { name: "customers", description: "Customer-Stammdaten (B2B)" },
      { name: "suppliers", description: "Lieferantenangebote und Beschaffung" },
      { name: "products", description: "Produkt-Katalog inkl. CSV-Import + Bilder" },
      { name: "pricing", description: "Pricing-Quote (Listenpreis + Mengenstaffel + Customer-Special)" },
      { name: "stock", description: "Lagerbestand + Movements" },
      { name: "batches", description: "Wareneingang mit MHD (FEFO)" },
      { name: "orders", description: "Bestellungen + Order-Document" },
      { name: "invoices", description: "Rechnungen (PDF in R2)" },
      { name: "webhooks", description: "Webhook-Subscriptions für Tenant-ERP-Integration" },
      { name: "customer-self", description: "Endkunden-Self-Service (JWT-authenticated)" },
      { name: "mcp", description: "Model Context Protocol für AI-Agents" },
    ],
    components: {
      securitySchemes: {
        tenant_hmac: {
          type: "apiKey",
          in: "header",
          name: "X-Api-Key",
          description: "Tenant-API-Key. Muss zusätzlich von X-Signature (HMAC-SHA256) und X-Timestamp begleitet werden.",
        },
        customer_jwt: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Customer-JWT (HS256, per-Tenant-Secret).",
        },
      },
      schemas: {
        Problem: ProblemSchema,
        Customer: CustomerSchemaJson,
        CustomerCreate: CustomerCreateJson,
        CustomerPatch: CustomerPatchJson,
        Product: ProductSchemaJson,
        ProductCreate: ProductCreateJson,
        ProductPatch: ProductPatchJson,
        Address: AddressJson,
        TaxClass: TaxClassJson,
        OrderDocument: OrderDocJson,
        CreateOrderRequest: CreateOrderRequestJson,
        OrderState: OrderStateJson,
        StepType: StepTypeJson,
        PricingResult: PricingResultJson,
        StockState: StockStateJson,
      },
    },
    paths,
  };
}

/** Liste aller mountierten Pfade — für Drift-Check-Test. */
export const KNOWN_PATHS: ReadonlyArray<string> = Object.freeze(Object.keys(paths));
