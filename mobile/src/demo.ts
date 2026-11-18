import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import {
  RequestFailure, type DemoScenario, type LineInput, type OperationResult,
  type Order, type OrderResult, type PilotApi, type Product, type Quote, type Session,
} from "./contracts";

const catalog: Product[] = [
  { id: "sku_rose_red", sku_code: "RO-RED-60", name: "Rose Red Naomi", variant: "Rot · 60 cm", sale_unit: "Karton", contains: 50, unit_of_inner: "Stiele", min_order_qty: 1 },
  { id: "sku_rose_white", sku_code: "RO-WHI-60", name: "Rose Avalanche", variant: "Weiß · 60 cm", sale_unit: "Karton", contains: 50, unit_of_inner: "Stiele", min_order_qty: 1 },
  { id: "sku_tulip", sku_code: "TU-PNK-40", name: "Tulpe Pink Impression", variant: "Rosa · 40 cm", sale_unit: "Karton", contains: 50, unit_of_inner: "Stiele", min_order_qty: 2 },
  { id: "sku_gerbera", sku_code: "GE-ORA-45", name: "Gerbera Terra", variant: "Orange · 45 cm", sale_unit: "Karton", contains: 30, unit_of_inner: "Stiele", min_order_qty: 1 },
];

const accounts: Record<string, string> = {
  "floraly@example.test": "Floraly Berlin",
  "blume@example.test": "Blume Amsterdam",
};
const snapshotKey = "grosshandel-demo-orders-v1";
const challenges = new Map<string, number>();
interface Snapshot {
  orders: Record<string, Order[]>;
  operations: Record<string, OrderResult>;
}
let queue: Promise<unknown> = Promise.resolve();

function transact<T>(action: (snapshot: Snapshot) => T | Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const stored = await AsyncStorage.getItem(snapshotKey);
    const snapshot: Snapshot = stored ? JSON.parse(stored) : { orders: {}, operations: {} };
    const result = await action(snapshot);
    await AsyncStorage.setItem(snapshotKey, JSON.stringify(snapshot));
    return result;
  });
  queue = next.catch(() => {});
  return next;
}

function requireOrder(snapshot: Snapshot, session: Session, id: string): Order {
  const order = snapshot.orders[session.customerId]?.find((item) => item.id === id);
  if (!order) throw new RequestFailure("Bestellung nicht verfügbar.", "GH-ORDER-001");
  return order;
}

function asResult(order: Order): OrderResult {
  return {
    order,
    allowed_actions: order.state === "awaiting_confirmation" ? ["confirm", "cancel"]
      : order.state === "on_hold" ? ["cancel"] : [],
  };
}

function price(session: Session, lines: LineInput[], extra = 0): Quote {
  const priced = lines.map((line) => {
    const item = catalog.find((product) => product.id === line.sku_id);
    if (!item || !Number.isInteger(line.qty) || line.qty < item.min_order_qty || line.qty > 500) {
      throw new RequestFailure("Prüfe die Menge und die Verkaufseinheit.", "GH-PROD-003");
    }
    const special = session.customerId === "blume@example.test" && line.sku_id === "sku_rose_red";
    const unit_price_cents = (special ? 890 : line.qty >= 10 ? 950 : 1000) + extra;
    return { ...line, unit_price_cents };
  });
  const subtotal_cents = priced.reduce((sum, line) => sum + line.qty * line.unit_price_cents, 0);
  const tax_cents = Math.round(subtotal_cents * 0.07);
  return { quote_id: Crypto.randomUUID(), lines: priced, totals: { currency: "EUR", subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents } };
}

function demoInvoice(order: Order, customer: string) {
  const lines = ["Musterrechnung", order.customer_reference, customer,
    ...order.lines.map((line) => `${line.qty} ${line.sale_unit} - ${line.name}`),
    `Gesamt: ${(order.totals.total_cents / 100).toFixed(2)} EUR`];
  const escaped = (value: string) => value.normalize("NFKD").replace(/[^ -~]/g, "").replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 14 Tf 46 795 Td 24 TL ${lines.map((line) => `(${escaped(line)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: "application/pdf" });
}

export function demoApi(scenario: DemoScenario): PilotApi {
  return {
    demo: true,
    async requestCode(email) {
      if (Object.hasOwn(accounts, email)) challenges.set(email, Date.now() + 600_000);
      return 600;
    },
    async signIn(email, code) {
      const expires = challenges.get(email);
      const customerName = accounts[email];
      if (!expires || expires < Date.now() || code !== "ABCD2345" || !customerName) {
        throw new RequestFailure("Der Code wurde nicht akzeptiert.", "GH-AUTH-006");
      }
      challenges.delete(email);
      return { customerId: email, customerName, merchantName: "Blumenhandel Aalsmeer", supportEmail: "hilfe@example.test" };
    },
    async restore(session) { return session; },
    async signOut() {},
    async catalog(_session, query) {
      const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      return catalog.filter((item) => tokens.every((token) =>
        `${item.name} ${item.variant} ${item.sku_code}`.toLowerCase().includes(token)));
    },
    async quote(session, lines) { return price(session, lines); },
    async draft(session, lines, _quoteId, key) {
      return transact((snapshot) => {
        const scope = `${session.customerId}:${key}`;
        const prior = snapshot.operations[scope];
        if (prior) return prior;
        const customerOrders = snapshot.orders[session.customerId] ??= [];
        const existing = customerOrders.find((item) => item.state === "awaiting_confirmation");
        if (existing) return asResult(existing);
        const quote = price(session, lines, scenario === "price" ? 50 : 0);
        const id = Crypto.randomUUID();
        const order: Order = {
          id, customer_reference: `GH-${id.slice(0, 8).toUpperCase()}`,
          revision: "1", state: scenario === "stock" ? "on_hold" : "awaiting_confirmation",
          lines: quote.lines.map((line) => {
            const item = catalog.find((product) => product.id === line.sku_id)!;
            return { ...line, name: item.name, sale_unit: item.sale_unit };
          }),
          totals: quote.totals, created_at: new Date().toISOString(),
          invoice_available: false,
          ...(scenario === "stock" ? { issues: [{ sku_id: lines[0].sku_id, code: "GH-STOCK-001" }] }
            : { reservation_expires_at: new Date(Date.now() + 7_200_000).toISOString() }),
        };
        customerOrders.unshift(order);
        return snapshot.operations[scope] = asResult(order);
      });
    },
    async confirm(session, order, key) {
      let lost = false;
      const result = await transact((snapshot) => {
        const scope = `${session.customerId}:${key}`;
        const prior = snapshot.operations[scope];
        if (prior) return prior;
        const current = requireOrder(snapshot, session, order.id);
        if (current.revision !== order.revision || current.state !== "awaiting_confirmation") {
          throw new RequestFailure("Der Auftrag hat sich geändert.", "GH-ORDER-002");
        }
        if (Date.parse(current.reservation_expires_at ?? "") <= Date.now()) {
          throw new RequestFailure("Die Reservierung ist abgelaufen.", "GH-STOCK-002");
        }
        current.state = "confirmed";
        current.revision = "2";
        current.invoice_available = true;
        lost = scenario === "lost";
        return snapshot.operations[scope] = asResult(current);
      });
      if (lost) throw new RequestFailure("Die Bestätigung konnte nicht empfangen werden.", "NETWORK");
      return result;
    },
    async cancel(session, order, key) {
      return transact((snapshot) => {
        const scope = `${session.customerId}:${key}`;
        const prior = snapshot.operations[scope];
        if (prior) return prior;
        const current = requireOrder(snapshot, session, order.id);
        if (current.state !== "awaiting_confirmation" && current.state !== "on_hold") {
          throw new RequestFailure("Die Bestellung kann nicht abgebrochen werden.", "GH-STATE-001");
        }
        current.state = "cancelled";
        current.revision = "2";
        return snapshot.operations[scope] = asResult(current);
      });
    },
    async operation(session, key): Promise<OperationResult> {
      return transact((snapshot) => {
        const result = snapshot.operations[`${session.customerId}:${key}`];
        return result ? { state: "completed", repeat_allowed: false, order: result.order }
          : { state: "not_recorded", repeat_allowed: true };
      });
    },
    async orders(session) { return transact((snapshot) => snapshot.orders[session.customerId] ?? []); },
    async order(session, id) { return transact((snapshot) => requireOrder(snapshot, session, id)); },
    async invoice(session, id) {
      const order = await transact((snapshot) => requireOrder(snapshot, session, id));
      if (!order.invoice_available) throw new RequestFailure("Rechnung noch nicht verfügbar.", "GH-PDF-001");
      return demoInvoice(order, session.customerName);
    },
  };
}
