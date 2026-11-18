import { env as testEnv, runDurableObjectAlarm, SELF } from "cloudflare:test";
import type { Env } from "../../src/env";
import { afterEach, describe, expect, it } from "vitest";
import { computeStockTargets, rebuildStockDO } from "../../src/services/stock-rebuild";
import { key } from "../../src/services/stock";

const env = testEnv as unknown as Env;
const p = { tenant_id: "tnt_dr", warehouse_id: "wh_dr", sku_id: "sku_dr" };

function stubFor(k: string) {
  return testEnv.STOCK_DO.get(testEnv.STOCK_DO.idFromName(k));
}
/** Antwort immer vollständig lesen — sonst scheitert die Storage-Isolation des Test-Pools. */
async function call(stub: ReturnType<typeof stubFor>, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await stub.fetch(`https://stock.local${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  return { status: res.status, json: await res.json() };
}
async function state(k: string): Promise<{ available: number; reserved: number; reservations: number; scope?: typeof p }> {
  return (await (await stubFor(k).fetch("https://stock.local/state")).json()) as never;
}
async function seedMovements(rows: Array<{ type: string; qty_delta: number }>, sku = p.sku_id): Promise<void> {
  let i = 0;
  for (const r of rows) {
    i += 1;
    await testEnv.DB.prepare(
      "INSERT INTO stock_movements (id, tenant_id, warehouse_id, sku_id, type, qty_delta, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(`evt_dr_${sku}_${i}`, p.tenant_id, p.warehouse_id, sku, r.type, r.qty_delta, `2026-11-17T10:00:0${i}Z`).run();
  }
}
async function plan() {
  const m = await testEnv.DB.prepare("SELECT tenant_id, warehouse_id, sku_id, type, qty_delta FROM stock_movements").all();
  const b = await testEnv.DB.prepare("SELECT tenant_id, warehouse_id, sku_id, qty, status FROM stock_batches").all();
  return computeStockTargets(m.results as never, b.results as never);
}

afterEach(async () => {
  await testEnv.DB.prepare("DELETE FROM stock_movements").run();
  await testEnv.DB.prepare("DELETE FROM stock_batches").run();
});

describe("computeStockTargets", () => {
  it("summiert qty_delta, Reservierungs-Bewegungen zählen 0", () => {
    const t = computeStockTargets([
      { ...p, type: "adjust", qty_delta: 100 },
      { ...p, type: "reserve", qty_delta: 0 },
      { ...p, type: "commit", qty_delta: -30 },
      { ...p, type: "auto_release", qty_delta: 0 },
    ], []);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ key: key(p), available: 70, movements: 4, batch_qty: null, warnings: [] });
  });

  it("Chargen: nur aktive, Abweichung wird gemeldet, Zielwert bleibt", () => {
    const [t] = computeStockTargets(
      [{ ...p, type: "adjust", qty_delta: 50 }],
      [{ ...p, qty: 40, status: "active" }, { ...p, qty: 99, status: "expired" }],
    );
    expect(t!.available).toBe(50);
    expect(t!.batch_qty).toBe(40);
    expect(t!.batch_drift).toBe(-10);
    expect(t!.warnings).toHaveLength(1);
  });
});

describe("StockDO /rebuild", () => {
  it("baut einen leeren DO aus den Bewegungen auf; /state stimmt", async () => {
    await seedMovements([{ type: "adjust", qty_delta: 100 }, { type: "commit", qty_delta: -25 }, { type: "reserve", qty_delta: 0 }]);
    const res = await rebuildStockDO(env, await plan());
    expect(res).toEqual([{ key: key(p), outcome: "rebuilt" }]);
    const s = await state(key(p));
    expect(s).toMatchObject({ available: 75, reserved: 0, reservations: 0, scope: p });
  });

  it("ist idempotent: zweiter Lauf ohne force ändert nichts", async () => {
    await seedMovements([{ type: "adjust", qty_delta: 10 }]);
    await rebuildStockDO(env, await plan());
    const again = await rebuildStockDO(env, await plan());
    expect(again).toEqual([{ key: key(p), outcome: "unchanged" }]);
    expect((await state(key(p))).available).toBe(10);
  });

  it("überschreibt vorhandenen, abweichenden Zustand nur mit force; verwirft Reservierungen", async () => {
    const k = key(p);
    const stub = stubFor(k);
    await call(stub, "/scope", p);
    await call(stub, "/adjust", { qty_delta: 5 });
    await call(stub, "/reserve", { qty: 2, ttl_sec: 600 });
    await seedMovements([{ type: "adjust", qty_delta: 40 }]);

    expect(await rebuildStockDO(env, await plan())).toEqual([{ key: k, outcome: "exists" }]);
    expect(await state(k)).toMatchObject({ available: 5, reservations: 1 });

    expect(await rebuildStockDO(env, await plan(), { force: true })).toEqual([{ key: k, outcome: "rebuilt" }]);
    expect(await state(k)).toMatchObject({ available: 40, reserved: 0, reservations: 0 });
    expect((await call(stub, "/drain-movements")).json.items).toEqual([]);
  });

  it("ein neu aufgebauter DO nimmt danach normale Reservierungen an", async () => {
    await seedMovements([{ type: "adjust", qty_delta: 3 }]);
    await rebuildStockDO(env, await plan());
    const stub = stubFor(key(p));
    const ok = await call(stub, "/reserve", { qty: 3, ttl_sec: 600 });
    expect(ok.status).toBe(200);
    expect((await call(stub, "/reserve", { qty: 1, ttl_sec: 600 })).status).toBe(409);
    await call(stub, "/release", { reservation_id: ok.json.reservation_id });
    // Alarm abarbeiten (keine Reservierung mehr offen), sonst scheitert die isolierte Storage-Bereinigung des Test-Pools.
    await runDurableObjectAlarm(stub);
  });
});

describe("/rebuild ist nicht öffentlich", () => {
  it.each(["/rebuild", "/v1/rebuild", "/v1/stock/rebuild", "/v1/stock/tnt/wh/sku/rebuild"])("%s liefert kein Rebuild", async (path) => {
    for (const method of ["GET", "POST"]) {
      const res = await SELF.fetch(`https://example.com${path}`, { method, body: method === "POST" ? "{}" : undefined });
      expect([401, 403, 404, 405]).toContain(res.status);
      expect(await res.text()).not.toContain("changed");
    }
  });
});
