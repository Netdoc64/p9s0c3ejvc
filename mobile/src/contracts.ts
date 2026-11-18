export interface Product {
  id: string;
  sku_code: string;
  name: string;
  variant: string;
  sale_unit: string;
  contains: number;
  unit_of_inner: string;
  min_order_qty: number;
  image_url?: string;
}

export interface LineInput {
  sku_id: string;
  qty: number;
}

export interface Totals {
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface Quote {
  netOnly?: boolean;
  quote_id: string;
  lines: (LineInput & { unit_price_cents: number })[];
  totals: Totals;
}

export interface Session {
  customerId: string;
  merchantName: string;
  customerName: string;
  supportEmail?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface Order {
  id: string;
  customer_reference: string;
  revision: string;
  allowed_actions?: ("confirm" | "cancel")[];
  state: "draft" | "resolving" | "awaiting_confirmation" | "confirmed" | "shipped" | "invoiced" | "paid" | "cancelled" | "on_hold";
  lines: (LineInput & { name: string; sale_unit: string; unit_price_cents: number })[];
  totals: Totals;
  created_at: string;
  reservation_expires_at?: string;
  invoice_available: boolean;
  issues?: { sku_id?: string; code: string }[];
}

export type OrderSummary = Pick<Order, "id" | "customer_reference" | "state" | "created_at" | "totals">;

export interface OrderResult {
  order: Order;
  allowed_actions: ("confirm" | "cancel")[];
}

export interface OperationResult {
  state: "pending" | "completed" | "not_recorded";
  repeat_allowed: boolean;
  order?: Order;
}

export type DemoScenario = "normal" | "price" | "stock" | "lost";

export interface PilotApi {
  readonly demo: boolean;
  requestCode(email: string): Promise<number>;
  signIn(email: string, code: string): Promise<Session>;
  restore(session: Session): Promise<Session>;
  signOut(session: Session): Promise<void>;
  catalog(session: Session, query: string): Promise<Product[]>;
  quote(session: Session, lines: LineInput[]): Promise<Quote>;
  draft(session: Session, lines: LineInput[], quoteId: string, key: string): Promise<OrderResult>;
  confirm(session: Session, order: Order, key: string): Promise<OrderResult>;
  cancel(session: Session, order: Order, key: string): Promise<OrderResult>;
  operation(session: Session, key: string): Promise<OperationResult>;
  orders(session: Session): Promise<OrderSummary[]>;
  order(session: Session, id: string): Promise<Order>;
  invoice(session: Session, id: string): Promise<Blob>;
}

export class RequestFailure extends Error {
  constructor(message: string, public readonly code: string, public readonly retryAfter?: number) {
    super(message);
  }
}

export const euro = (cents: number, currency = "EUR") =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
