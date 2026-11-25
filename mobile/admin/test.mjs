import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDashboard } from "./data.mjs";

test("Preise, Lagerbestände, Bestellungen und Retouren sind vollständig zugeordnet", async () => {
  const data = await loadDashboard();
  for (const product of data.products.items) {
    assert.ok(data.prices.has(product.id));
    assert.ok(data.inventory.some(i => i.sku_id === product.id));
  }
  for (const order of data.orders.items) {
    assert.ok(data.customers.items.some(c => c.id === order.customer_id));
  }
  for (const item of data.returns.items) {
    assert.ok(data.orders.items.some(o => o.id === item.order_id));
  }
});
