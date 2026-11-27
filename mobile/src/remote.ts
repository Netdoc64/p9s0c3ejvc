import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { pilotConfiguration } from "./config";
import { describeRequestFailure } from "./request-failure";
import { RequestFailure, type LineInput, type OperationResult, type Order, type OrderResult, type OrderSummary, type PilotApi, type Product, type Quote, type Session } from "./contracts";

interface Tokens { access_token: string; refresh_token: string }
interface Profile {
  customer: { id: string; name: string };
  merchant: { name: string | null };
}
interface WireProduct {
  id: string;
  sku_code: string;
  name: string;
  description: string | null;
  min_order_qty: number;
  image_url?: string | null;
  packaging_units?: { name: string; contains: number; unit_of_inner: string }[];
}
interface WireQuote extends LineInput {
  unit_price_cents: number;
  total_cents: number;
  currency: string;
}
interface WireOrder {
  id: string;
  revision: string;
  state: Order["state"];
  currency: string;
  created_at: string | null;
  totals: Omit<Order["totals"], "currency">;
  lines: (LineInput & { name: string | null; unit_price_cents: number | null; line_no: number; sale_unit?: string })[];
  invoice: { available: true } | null;
  blocking: { code: string; line_no?: number }[];
  allowed_actions: OrderResult["allowed_actions"];
  reservation_expires_at?: string;
}
interface WireOrderSummary {
  id: string;
  state: Order["state"];
  total_cents: number;
  currency: string;
  created_at: string;
}

function normalizeOrder(value: WireOrder): OrderResult {
  const order: Order = {
    id: value.id, customer_reference: value.id, state: value.state, revision: value.revision,
    created_at: value.created_at ?? "", totals: { ...value.totals, currency: value.currency },
    lines: value.lines.map((line) => ({
      sku_id: line.sku_id, qty: line.qty, name: line.name ?? line.sku_id,
      sale_unit: line.sale_unit ?? "Einheit", unit_price_cents: line.unit_price_cents ?? 0,
    })),
    invoice_available: value.invoice?.available === true, reservation_expires_at: value.reservation_expires_at,
    issues: value.blocking.map((issue) => ({
      code: issue.code, sku_id: value.lines.find((line) => line.line_no === issue.line_no)?.sku_id,
    })),
    allowed_actions: value.allowed_actions,
  };
  return { order, allowed_actions: value.allowed_actions };
}
function normalizeProduct(value: WireProduct): Product {
  const unit = Array.isArray(value.packaging_units) ? value.packaging_units[0] : undefined;
  return {
    id: value.id, sku_code: value.sku_code, name: value.name, variant: value.description ?? "",
    min_order_qty: value.min_order_qty, image_url: value.image_url ?? undefined,
    sale_unit: unit?.name === "carton" ? "Karton" : unit?.name ?? "Einheit",
    contains: unit?.contains ?? 1, unit_of_inner: unit?.unit_of_inner === "stem" ? "Stiele" : unit?.unit_of_inner ?? "Stück",
  };
}
const clientId = "grosshandel-mobile";
export const remoteSessionStore = "grosshandel-pilot-session";

export function remoteApi(baseUrl: string, tenant: string): PilotApi {
  const base = baseUrl.replace(/\/$/, "");
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error("Die Kunden-API braucht eine HTTPS-Adresse.");
  }

  async function request(path: string, options: { session?: Session; body?: object; key?: string; pdf?: boolean } = {}) {
    const headers: Record<string, string> = { "X-Tenant-Slug": tenant, "X-Client-Version": "0.1.0", "X-Client-Platform": Platform.OS };
    if (options.session?.accessToken) headers.Authorization = `Bearer ${options.session.accessToken}`;
    if (options.body) headers["Content-Type"] = "application/json";
    if (options.key) headers["X-Idempotency-Key"] = options.key;
    let response: Response;
    try {
      response = await fetch(base + path, {
        headers, method: options.body ? "POST" : "GET",
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      const failure = await describeRequestFailure();
      throw new RequestFailure(failure.message, failure.code);
    }
    if (!response.ok) {
      const failure = await describeRequestFailure(response);
      throw new RequestFailure(failure.message, failure.code, failure.retryAfter);
    }
    if (response.status === 204) return undefined;
    return options.pdf ? response.blob() : response.json();
  }

  const refreshing = new WeakMap<Session, Promise<void>>();

  async function customer<T>(path: string, session: Session, body?: object, key?: string, pdf = false): Promise<T> {
    const accessToken = session.accessToken;
    const call = () => request(`/v1/customer${path}`, { session, body, key, pdf }) as Promise<T>;
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RequestFailure) || error.code !== "GH-AUTH-005" || !session.refreshToken) throw error;
    }
    if (accessToken === session.accessToken) {
      let refresh = refreshing.get(session);
      if (!refresh) {
        refresh = rotate(session).then(async (tokens) => {
          session.accessToken = tokens.access_token;
          session.refreshToken = tokens.refresh_token;
          if (Platform.OS !== "web") await SecureStore.setItemAsync(remoteSessionStore, JSON.stringify(session));
        }).catch(async (error: unknown) => {
          if (error instanceof RequestFailure && error.code === "NETWORK") {
            // The server may have rotated the token already. Require a new login instead of replaying it.
            session.refreshToken = undefined;
            if (Platform.OS !== "web") await SecureStore.deleteItemAsync(remoteSessionStore);
            throw new RequestFailure("Die Sitzung konnte nicht erneuert werden. Bitte melde dich erneut an.", "REAUTH");
          }
          throw error;
        }).finally(() => { refreshing.delete(session); });
        refreshing.set(session, refresh);
      }
      await refresh;
    }
    return call();
  }

  function rotate(session: Session) {
    return request("/v1/auth/oauth/token", {
      body: { grant_type: "refresh_token", refresh_token: session.refreshToken },
    }) as Promise<Tokens>;
  }

  async function sessionFromTokens(tokens: Tokens): Promise<Session> {
    const profile = await customer<Profile>("/me", { accessToken: tokens.access_token } as Session);
    return {
      customerId: profile.customer.id, customerName: profile.customer.name, merchantName: profile.merchant.name ?? "Grosshandel",
      supportEmail: pilotConfiguration.supportEmail, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    };
  }

  return {
    demo: false,
    async requestCode(email) {
      const result = await request("/v1/auth/magic-link/request", { body: { email } }) as { ttl_sec: number };
      return result.ttl_sec;
    },
    async signIn(email, code) {
      const verifier = Crypto.randomUUID().replaceAll("-", "") + Crypto.randomUUID().replaceAll("-", "");
      const challenge = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const state = Crypto.randomUUID();
      const auth = await request("/v1/auth/oauth/authorize", {
        body: { client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", email, magic_link_code: code, state },
      }) as { code: string; state: string };
      if (auth.state !== state) throw new RequestFailure("Die Anmeldung konnte nicht überprüft werden.", "GH-AUTH-008");
      return sessionFromTokens(await request("/v1/auth/oauth/token", {
        body: { grant_type: "authorization_code", code: auth.code, code_verifier: verifier, client_id: clientId },
      }) as Tokens);
    },
    async restore(session) {
      const profile = await customer<Profile>("/me", session);
      if (profile.customer.id !== session.customerId) throw new RequestFailure("Bitte melde dich erneut an.", "GH-AUTH-007");
      return { ...session, customerName: profile.customer.name, merchantName: profile.merchant.name ?? "Grosshandel", supportEmail: pilotConfiguration.supportEmail };
    },
    async signOut(session) {
      if (session.refreshToken) await request("/v1/auth/oauth/revoke", { body: { token: session.refreshToken, token_type_hint: "refresh_token" } });
    },
    async catalog(session, query) {
      let cursor: string | null = null;
      const items: Product[] = [];
      do {
        const path: string = `/products?limit=50${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page: { items: WireProduct[]; next_cursor: string | null } = await customer(path, session);
        items.push(...page.items.map(normalizeProduct));
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    },
    async quote(session, lines): Promise<Quote> {
      // The shared endpoint prices one line at a time. Avoid flooding the same D1 database.
      const quotes: WireQuote[] = [];
      for (const line of lines) {
        quotes.push(await customer<WireQuote>("/quotes", session, line));
      }
      const subtotal_cents = quotes.reduce((total, line) => total + line.total_cents, 0);
      if (quotes.some((line) => line.currency !== quotes[0]?.currency)) {
        throw new RequestFailure("Die Positionen haben unterschiedliche Währungen.", "PRICE-CURRENCY");
      }
      return {
        netOnly: true, quote_id: "net-preview",
        lines: quotes.map(({ sku_id, qty, unit_price_cents }) => ({ sku_id, qty, unit_price_cents })),
        totals: { currency: quotes[0]?.currency ?? "EUR", subtotal_cents, tax_cents: 0, total_cents: subtotal_cents },
      };
    },
    async draft(session, lines, _quoteId, key) {
      return normalizeOrder(await customer<WireOrder>("/orders", session, { operation_id: key, lines }, key));
    },
    async confirm(session, order, key) {
      return normalizeOrder(await customer<WireOrder>(`/orders/${encodeURIComponent(order.id)}/confirm`, session, { operation_id: key, expected_revision: order.revision }, key));
    },
    async cancel(session, order, key) {
      return normalizeOrder(await customer<WireOrder>(`/orders/${encodeURIComponent(order.id)}/cancel`, session, { operation_id: key }, key));
    },
    async operation(session, key) {
      const result = await customer<Omit<OperationResult, "order"> & { order?: WireOrder }>(`/order-operations/${encodeURIComponent(key)}`, session);
      return { ...result, order: result.order ? normalizeOrder(result.order).order : undefined };
    },
    async orders(session) {
      const items: OrderSummary[] = [];
      let cursor: string | null = null;
      do {
        const path: string = `/orders?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page: { items: WireOrderSummary[]; next_cursor: string | null } = await customer(path, session);
        items.push(...page.items.map((item) => ({
          id: item.id, customer_reference: item.id, state: item.state, created_at: item.created_at,
          totals: { currency: item.currency, subtotal_cents: 0, tax_cents: 0, total_cents: item.total_cents },
        })));
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    },
    async order(session, id) {
      return normalizeOrder(await customer<WireOrder>(`/orders/${encodeURIComponent(id)}`, session)).order;
    },
    invoice(session, id) { return customer<Blob>(`/orders/${encodeURIComponent(id)}/invoice`, session, undefined, undefined, true); },
  };
}
