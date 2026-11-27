// Adapter für die Demo. Die spätere Mitarbeiter-Sitzung gehört ausschließlich hierher.
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
export async function loadDashboard() {
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
