import { Hono } from "hono";
import { z } from "zod";
import { toJsonSchema } from "../openapi/json-schema";
import type { AppContext } from "../env";
import { CodedError, ERROR_CATALOG } from "../errors/catalog";
import { getDb } from "../db/client";
import { verifyJwt, type JwtSecretSet } from "../auth/jwt";
import { getTenantById } from "../lib/tenant-cache";
import { findTool, TOOLS } from "../mcp/tools";
import * as productsRepo from "../repos/products";
import * as customersRepo from "../repos/customers";
import * as ordersRepo from "../repos/orders";
import { resolvePricingFromDb } from "../services/pricing-resolver";
import * as customerOrders from "../services/customer-orders";

export const mcpRoutes = new Hono<AppContext>();

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

interface AuthCtx { tenant_id: string; customer_id: string; scopes: string[]; }

async function authenticate(c: import("hono").Context<AppContext>): Promise<AuthCtx> {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) throw new CodedError("GH-AUTH-001");
  const token = auth.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new CodedError("GH-AUTH-002");
  let claimedTenant: string;
  try {
    const p = parts[1] as string;
    const padded = p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { tenant_id?: string };
    if (!json.tenant_id) throw new Error();
    claimedTenant = json.tenant_id;
  } catch { throw new CodedError("GH-AUTH-002"); }

  const t = await getTenantById(c.env, claimedTenant);
  if (!t || t.status !== "active") throw new CodedError("GH-TENANT-001");
  const secretSet: JwtSecretSet = {
    current: t.customer_jwt_secret,
    ...(t.customer_jwt_secret_previous && t.customer_jwt_secret_previous_until && t.customer_jwt_secret_previous_until > new Date().toISOString()
      ? { previous: t.customer_jwt_secret_previous }
      : {}),
  };
  const result = await verifyJwt(token, secretSet, t.id);
  if (!result.ok) throw new CodedError(result.reason === "expired" ? "GH-AUTH-005" : "GH-AUTH-002");
  return { tenant_id: t.id, customer_id: result.payload.sub, scopes: result.payload.scope };
}

function rpcResult(id: string | number | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}
function rpcError(id: string | number | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message, data } };
}

mcpRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) return c.json(rpcError(undefined, -32700, "Parse error"), 400);
  const req = parsed.data;

  // MCP-PROTOKOLL (2024-11-05). Bis 2026-11-17 beantwortete dieser Endpunkt
  // `notifications/initialized` — die Nachricht, die JEDER Client direkt nach
  // `initialize` schickt — mit 400 method_not_found, und `tools/call` gab das
  // rohe Ergebnis statt `{ content: [...] }` zurück. Kein Standard-Client
  // hätte damit arbeiten können. scripts/smoke-mcp.ts prüft das gegen Staging.

  // Benachrichtigungen (ohne id) bekommen keine JSON-RPC-Antwort: 202, leer.
  if (req.id === undefined && req.method.startsWith("notifications/")) {
    return c.body(null, 202);
  }

  if (req.method === "ping") return c.json(rpcResult(req.id, {}));

  // initialize akzeptiert ohne Auth (Capabilities-Discovery)
  if (req.method === "initialize") {
    return c.json(rpcResult(req.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "grosshandel-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
    }));
  }

  // Ab hier Auth Pflicht.
  let auth: AuthCtx;
  try { auth = await authenticate(c); } catch (err) {
    return c.json(rpcError(req.id, -32001, "auth_failed", { code: (err as { code?: string }).code ?? "GH-AUTH-001" }), 401);
  }

  if (req.method === "tools/list") {
    return c.json(rpcResult(req.id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        // #M-002: vollständiger Konverter via lib statt Mini-Konverter.
        inputSchema: toJsonSchema(t.inputSchema as z.ZodType),
      })),
    }));
  }

  if (req.method === "tools/call") {
    const args = req.params ?? {};
    const name = args.name as string | undefined;
    const inputs = (args.arguments ?? {}) as Record<string, unknown>;
    const tool = name ? findTool(name) : undefined;
    if (!tool) return c.json(rpcError(req.id, -32602, "unknown_tool"), 400);

    // Scope-Check (#M-001): explizit gegen requiredScope.
    // Backward-Compat: wer noch nur "customer_self" hat, bekommt beide gemappt.
    const effectiveScopes = expandLegacyScopes(auth.scopes);
    if (!effectiveScopes.includes(tool.requiredScope)) {
      return c.json(rpcError(req.id, -32004, "scope_insufficient", { code: "GH-AUTH-004", required: tool.requiredScope }), 403);
    }

    const validated = (tool.inputSchema as z.ZodTypeAny).safeParse(inputs);
    if (!validated.success) return c.json(rpcError(req.id, -32602, "invalid_arguments", validated.error.flatten()), 400);

    // Ergebnis in der Form der MCP-Spec: Text für das Modell, dazu
    // `structuredContent` für Clients, die es lesen. Ein fachlicher Fehler ist
    // ein Werkzeug-Ergebnis mit `isError` (das Modell soll ihn sehen und
    // reagieren), kein Protokollfehler.
    try {
      const result = await callTool(c, auth, tool.name, validated.data as Record<string, unknown>) as Record<string, unknown>;
      const summary = typeof result.summary === "string" ? result.summary : undefined;
      return c.json(rpcResult(req.id, {
        content: [{ type: "text", text: summary ? `${summary}

${JSON.stringify(result)}` : JSON.stringify(result) }],
        structuredContent: result,
      }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "GH-INFRA-002";
      const known = code in ERROR_CATALOG ? ERROR_CATALOG[code as keyof typeof ERROR_CATALOG] : undefined;
      return c.json(rpcResult(req.id, {
        isError: true,
        content: [{ type: "text", text: `${code}: ${known?.user_message ?? "Werkzeug fehlgeschlagen."}` }],
        structuredContent: { code },
      }));
    }
  }

  return c.json(rpcError(req.id, -32601, "method_not_found"), 400);
});

async function callTool(c: import("hono").Context<AppContext>, auth: AuthCtx, name: string, input: Record<string, unknown>): Promise<unknown> {
  const db = getDb(c.env.DB);

  if (name === "search_products") {
    const q = input.q as string;
    const limit = (input.limit as number | undefined) ?? 20;
    const items = await productsRepo.search(db, auth.tenant_id, q, limit);
    // #M-004: Customer-bereitgestellte query-string für summary sanitisieren.
    return { items: items.map((p) => ({ id: p.id, sku_code: p.sku_code, name: p.name })), summary: `Gefunden: ${items.length} Treffer für "${sanitizeForLlm(q, 80)}"` };
  }

  if (name === "get_price_quote") {
    const result = await resolvePricingFromDb(db, {
      tenant_id: auth.tenant_id,
      customer_id: auth.customer_id,
      sku_id: input.sku_id as string,
      qty: input.qty as number,
      on_date: new Date().toISOString(),
    });
    return result;
  }

  if (name === "list_customers") {
    // MCP-Customer sieht nur sich selbst (Scope `customer_self`)
    const own = await customersRepo.findById(db, auth.tenant_id, auth.customer_id);
    return { items: own ? [{ id: own.id, name: own.name }] : [] };
  }

  // Bestellungen über denselben Dienst wie die Kunden-REST-API: Eigentum wird
  // dort geprüft, und nach außen geht nur die Kundenansicht (G3) — vorher gab
  // dieser Endpunkt das vollständige interne Dokument samt audit/plan aus.
  const s = { tenant_id: auth.tenant_id, customer_id: auth.customer_id };

  if (name === "create_order_draft") {
    if ((input.customer_id as string) !== auth.customer_id) throw new CodedError("GH-AUTH-004");
    const doc = await customerOrders.createDraft(c.env, s, input.lines as Array<{ sku_id: string; qty: number }>, "mcp");
    const v = await customerOrders.view(c.env, s, doc);
    const total = `${(v.totals.total_cents / 100).toFixed(2).replace(".", ",")} ${v.currency}`;
    return {
      doc: v,
      summary: v.state === "awaiting_confirmation"
        ? `Entwurf ${v.id} für ${v.lines.length} Position${v.lines.length === 1 ? "" : "en"} angelegt, Summe ${total}. Rufe confirm_order(order_id="${v.id}") auf, um zu bestätigen — oder cancel_order, um abzubrechen.`
        : `Entwurf ${v.id} ist angehalten (${v.state}): ${v.blocking.map((b) => b.detail ?? b.code).join("; ")}.`,
    };
  }

  if (name === "confirm_order") {
    const doc = await customerOrders.confirm(c.env, s, input.order_id as string);
    const v = await customerOrders.view(c.env, s, doc);
    return { doc: v, summary: `Bestellung ${v.id} bestätigt${v.invoice ? `, Rechnung ${v.invoice.number}` : ""}.` };
  }

  if (name === "cancel_order") {
    const doc = await customerOrders.cancel(c.env, s, input.order_id as string, input.reason as string | undefined);
    return { doc: await customerOrders.view(c.env, s, doc), summary: `Bestellung ${input.order_id as string} storniert.` };
  }

  if (name === "get_order") {
    const r = await customerOrders.requireOwn(c.env, s, input.order_id as string);
    return { doc: await customerOrders.view(c.env, s, r.doc) };
  }

  if (name === "list_orders") {
    const items = await ordersRepo.list(db, auth.tenant_id, { customer_id: auth.customer_id, state: input.state as string | undefined, limit: input.limit as number | undefined });
    const { signCursor } = await import("../lib/http");
    return {
      items: items.items.map((r) => ({ id: r.id, state: r.state_current, total_cents: r.total_cents, currency: r.currency, created_at: r.created_at })),
      next_cursor: items.next_cursor ? await signCursor(c.env, items.next_cursor) : null,
    };
  }

  throw new CodedError("GH-INFRA-002", { reason: `unknown_tool: ${name}` });
}

/**
 * Legacy-Scope-Expansion (#M-001):
 * Tokens vor der Scope-Trennung haben nur "customer_self". Diese werden
 * automatisch auf read+write gemapped (Customer darf eigene Daten ändern).
 */
/**
 * Prompt-Injection-Schutz (#M-004): Customer-strings für AI-Modell-Output bereinigen.
 * Strippt Newlines, Brackets, Code-Fences die ein Modell als Marker fehlinterpretieren könnte.
 * Maximale Länge cap, damit überlange Names das Context-Window nicht fluten.
 */
function sanitizeForLlm(s: string, maxLen = 200): string {
  if (!s) return "";
  return s
    .replace(/[\r\n\t]/g, " ")
    .replace(/[<>{}`]/g, "")
    .slice(0, maxLen);
}

function expandLegacyScopes(scopes: string[]): string[] {
  const out = new Set(scopes);
  if (out.has("customer_self")) {
    out.add("customer_self.read");
    out.add("customer_self.write");
  }
  return [...out];
}

