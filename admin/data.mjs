import { api, live } from "./api.mjs";

const tenant_id = "t_demo";
const products = [
  { id: "sku_apfel", sku_code: "OB-01", name: "Äpfel · Kiste", tenant_id, tax_class: "reduced" },
  { id: "sku_birne", sku_code: "OB-02", name: "Birnen · Kiste", tenant_id, tax_class: "reduced" },
];
const customers = [
  { id: "cust_demo", tenant_id, name: "Demo-Einkauf", email: "einkauf@handel.example", country: "DE", b2b_b2c: "b2b", vat_status: "unknown" },
];
const orders = [
  { id: "ord_demo", customer_id: "cust_demo", state: "confirmed", total_cents: 4800, currency: "EUR", created_at: "2026-05-01T09:00:00Z" },
];
const returns = [
  { id: "ret_demo", version: 1, order_id: "ord_demo", kind: "return", lines: [{ order_line_no: 1, qty: 1 }] },
];
const price = (/** @type {number} */ cents) => ({
  unit_price_cents: cents, currency: "EUR", breakdown: [], decision_reason: "list_item",
});
function demoDashboard() {
  return {
    products: { items: products, next_cursor: null },
    customers: { items: customers, next_cursor: null },
    orders: { items: orders, next_cursor: null },
    returns: { items: returns, next: null },
    inventory: [
      { sku_id: "sku_apfel", warehouse_id: "wh_demo", state: { available: 24, reserved: 3 } },
      { sku_id: "sku_birne", warehouse_id: "wh_demo", state: { available: 16, reserved: 0 } },
    ],
    prices: new Map([["sku_apfel", price(1600)], ["sku_birne", price(1800)]]),
  };
}

/** @typedef {{id: string, sku_code: string, name: string}} Product */
/** @typedef {{id: string, name: string, email: string, country: string}} Customer */
/** @typedef {{id: string, customer_id: string, state: string, total_cents: number, currency: string}} Order */
/** @typedef {{sku_id: string, warehouse_id: string, available: number, reserved: number}} Stock */
/** @typedef {{id: string, kind: string, order_id: string, lines?: object[]}} ReturnCase */

/** @template T @param {string} path @returns {Promise<T[]>} */
async function list(path) {
  /** @type {T[]} */
  const items = [];
  /** @type {string | null} */
  let cursor = null;
  do {
    /** @type {{items: T[], next_cursor: string | null}} */
    const page = await api(path + "?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

/** @param {Order[]} orders */
async function listReturns(orders) {
  /** @type {ReturnCase[]} */
  const items = [];
  for (const order of orders) {
    /** @type {string | null} */
    let after = null;
    do {
      /** @type {{items: ReturnCase[], next: string | null}} */
      const page = await api(`/v1/orders/${encodeURIComponent(order.id)}/returns` + (after ? "?after=" + encodeURIComponent(after) : ""));
      items.push(...page.items.map(item => ({ ...item, order_id: order.id })));
      after = page.next;
    } while (after);
  }
  return items;
}

export async function loadDashboard() {
  if (!live) return demoDashboard();
  /** @type {[Product[], Customer[], Order[], Stock[]]} */
  const [products, customers, orders, inventory] = await Promise.all([
    list("/v1/products"), list("/v1/customers"), list("/v1/orders"), list("/v1/stock/overview"),
  ]);
  const returns = await listReturns(orders);
  return {
    products: { items: products },
    customers: { items: customers },
    orders: { items: orders },
    returns: { items: returns },
    inventory: inventory.map(({ sku_id, warehouse_id, available, reserved }) =>
      ({ sku_id, warehouse_id, state: { available, reserved } })),
    /** @type {Map<string, {unit_price_cents: number, currency: string}>} */
    prices: new Map(),
  };
}
