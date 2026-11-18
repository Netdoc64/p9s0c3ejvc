import { env as testEnv, runDurableObjectAlarm } from "cloudflare:test";
import type { Env, QueueMessage } from "../../src/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueHandler } from "../../src/workers/queue-handler";
import { key } from "../../src/services/stock";

const env = testEnv as unknown as Env;
const p = { tenant_id: "tnt_trg", warehouse_id: "wh_trg", sku_id: "sku_trg" };

function stubFor(k: string) {
  return testEnv.STOCK_DO.get(testEnv.STOCK_DO.idFromName(k));
}
async function state(k: string): Promise<{ available: number; reservations: number }> {
  return (await (await stubFor(k).fetch("https://stock.local/state")).json()) as never;
}
async function post(k: string, path: string, body: unknown) {
  const res = await stubFor(k).fetch(`https://stock.local${path}`, { method: "POST", body: JSON.stringify(body) });
  await res.text();
}
async function seed(qty: number) {
  await testEnv.DB.prepare(
    "INSERT INTO stock_movements (id, tenant_id, warehouse_id, sku_id, type, qty_delta, created_at) VALUES (?,?,?,?,?,?,?)",
  ).bind("evt_trg_1", p.tenant_id, p.warehouse_id, p.sku_id, "adjust", qty, "2026-11-18T10:00:00Z").run();
}
function run(body: QueueMessage) {
  const msg = { body, ack: vi.fn(), retry: vi.fn() };
  return queueHandler({ messages: [msg] } as unknown as MessageBatch<QueueMessage>, env).then(() => msg);
}

afterEach(async () => {
  await testEnv.DB.prepare("DELETE FROM stock_movements").run();
  await testEnv.DB.prepare("DELETE FROM stock_batches").run();
});

describe("Queue-Auftrag stock_rebuild", () => {
  it("berechnet den Plan aus D1 und baut den DO auf; Auftrag wird ack'd", async () => {
    await seed(42);
    const msg = await run({ kind: "stock_rebuild" });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect((await state(key(p))).available).toBe(42);
  });

  it("ohne force bleibt ein abweichender DO unberührt, mit force wird er überschrieben", async () => {
    const k = key(p);
    await post(k, "/scope", p);
    await post(k, "/adjust", { qty_delta: 5 });
    await seed(40);
    await run({ kind: "stock_rebuild" });
    expect((await state(k)).available).toBe(5);
    await run({ kind: "stock_rebuild", force: true });
    expect((await state(k)).available).toBe(40);
    await runDurableObjectAlarm(stubFor(k));
  });

  it("nimmt einen mitgegebenen Plan statt D1", async () => {
    const msg = await run({
      kind: "stock_rebuild",
      targets: [{ key: key(p), scope: p, available: 7, movements: 1, batch_qty: null, batch_drift: null, warnings: [] }],
    });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect((await state(key(p))).available).toBe(7);
  });

  it("Fehler im Rebuild führt zum Retry statt zum Verlust", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as Env;
    const msg = { body: { kind: "stock_rebuild" } as QueueMessage, ack: vi.fn(), retry: vi.fn() };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await queueHandler({ messages: [msg] } as unknown as MessageBatch<QueueMessage>, broken);
    log.mockRestore();
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
