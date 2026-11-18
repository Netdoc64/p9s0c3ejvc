import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { outbox_events, webhook_deliveries, webhook_subscriptions } from "../../src/db/schema/webhooks";
import { deliverEvent, emit } from "../../src/services/outbox";
import { queueHandler } from "../../src/workers/queue-handler";
import { hmacSha256Hex } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";
import { CodedError } from "../../src/errors/catalog";
import type { Env, OutboxMessage } from "../../src/env";
import { clearTenants, seedTenant, type SeededTenant } from "../_setup/seed";

const URL_OK = "https://hooks.example.com/grosshandel";
const SECRET = "example-shared-signing-value";
const BACKOFF = [1, 10, 60, 600, 3600, 21600];

let tenant: SeededTenant;
let sends: Array<{ body: unknown; opts?: { delaySeconds?: number } }>;
let testEnv: Env;
let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

function respond(status: number) {
  fetchMock.mockImplementation(async () => new Response("x", { status }));
}

async function addSub(over: Partial<typeof webhook_subscriptions.$inferInsert> = {}): Promise<string> {
  const id = newId("event");
  const now = new Date().toISOString();
  await getDb(env.DB).insert(webhook_subscriptions).values({
    id, tenant_id: tenant.tenant_id, url: URL_OK, topic_filter: "*", signing_secret: SECRET,
    active: 1, created_at: now, updated_at: now, ...over,
  });
  return id;
}

async function getEvent(id: string) {
  return (await getDb(env.DB).select().from(outbox_events).where(eq(outbox_events.id, id)))[0]!;
}
async function getDeliveries(id: string) {
  return getDb(env.DB).select().from(webhook_deliveries).where(eq(webhook_deliveries.event_id, id));
}

function batchOf(event_id: string) {
  const msg = { body: { event_id }, ack: vi.fn(), retry: vi.fn() };
  return { msg, batch: { messages: [msg], queue: "q" } as unknown as MessageBatch<OutboxMessage> };
}

beforeEach(async () => {
  tenant = await seedTenant({ slug: "outbox-delivery" });
  sends = [];
  testEnv = {
    ...env,
    DB: env.DB,
    OUTBOX_QUEUE: { send: async (body: unknown, opts?: { delaySeconds?: number }) => { sends.push({ body, opts }); } },
  } as unknown as Env;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.DB.prepare("DELETE FROM webhook_deliveries").run();
  await env.DB.prepare("DELETE FROM webhook_subscriptions").run();
  await env.DB.prepare("DELETE FROM outbox_events").run();
  await clearTenants();
});

describe("Outbox -> Queue -> Zustellung", () => {
  it("emit schreibt outbox_events und sendet auf die Queue; Handler liefert signiert aus", async () => {
    const subId = await addSub();
    respond(200);
    const { event_id } = await emit(
      { tenant_id: tenant.tenant_id, topic: "order.created", aggregate_id: "ord_1", payload: { b: 2, a: { z: 1, y: [3, 1] } } },
      { env: testEnv },
    );
    expect((await getEvent(event_id)).status).toBe("pending");
    expect(sends).toEqual([{ body: { event_id }, opts: undefined }]);

    const { msg, batch } = batchOf(event_id);
    await queueHandler(batch, testEnv);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    const body = init.body as string;
    // kanonisch: sortierte Keys
    expect(body).toContain('"payload":{"a":{"y":[3,1],"z":1},"b":2}');
    const expected = await hmacSha256Hex(SECRET, `${h["X-Grosshandel-Timestamp"]}.${body}`);
    expect(h["X-Grosshandel-Signature"]).toBe(`sha256=${expected}`);
    expect(Math.abs(Number(h["X-Grosshandel-Timestamp"]) - Date.now() / 1000)).toBeLessThan(10);
    expect(h["X-Grosshandel-Idempotency-Key"]).toBe(event_id);
    expect(h["X-Grosshandel-Delivery-Attempt"]).toBe("1");
    expect(h["X-Grosshandel-Event"]).toBe("order.created");

    const evt = await getEvent(event_id);
    expect(evt.status).toBe("delivered");
    expect(evt.attempt).toBe(1);
    const dl = await getDeliveries(event_id);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ subscription_id: subId, status: "delivered", attempt: 1, response_status: 200 });
  });

  it("500 -> retrying, retry_at und Queue-Send mit delaySeconds aus BACKOFF_SEC", async () => {
    await addSub();
    respond(500);
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "order.created", aggregate_id: "o", payload: {} }, { env: testEnv });
    sends.length = 0;
    const before = Date.now();
    await deliverEvent(testEnv, event_id);

    const evt = await getEvent(event_id);
    expect(evt.status).toBe("retrying");
    expect(evt.attempt).toBe(1);
    expect(sends).toHaveLength(1);
    const delay = sends[0]!.opts!.delaySeconds!;
    expect(delay).toBe(BACKOFF[0]); // erster Retry nach 1 s
    const retryAt = Date.parse(evt.retry_at!);
    expect(retryAt).toBeGreaterThanOrEqual(before + delay * 1000 - 50);
    expect(retryAt).toBeLessThan(before + delay * 1000 + 5000);
    const dl = await getDeliveries(event_id);
    expect(dl[0]).toMatchObject({ status: "retrying", response_status: 500, error_detail: "http 500" });
  });

  it("Backoff folgt je Versuch der Tabelle; nach 6 Versuchen dead_letter und kein weiterer Versand", async () => {
    await addSub();
    respond(500);
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "order.created", aggregate_id: "o", payload: {} }, { env: testEnv });
    const delays: number[] = [];
    for (let i = 1; i <= 6; i++) {
      sends.length = 0;
      await deliverEvent(testEnv, event_id);
      expect((await getEvent(event_id)).attempt).toBe(i);
      if (i < 6) delays.push(sends[0]!.opts!.delaySeconds!);
    }
    expect(delays).toEqual(BACKOFF.slice(0, 5));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const evt = await getEvent(event_id);
    expect(evt.status).toBe("dead_letter");
    expect(sends).toHaveLength(0); // kein Re-Enqueue nach dem letzten Versuch

    await deliverEvent(testEnv, event_id);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect((await getDeliveries(event_id)).map((d) => d.attempt).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("Netzwerkfehler wird wie Fehlerantwort behandelt (retrying)", async () => {
    await addSub();
    fetchMock.mockRejectedValue(new Error("boom"));
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "t.v1", aggregate_id: "o", payload: {} }, { env: testEnv });
    await deliverEvent(testEnv, event_id);
    expect((await getEvent(event_id)).status).toBe("retrying");
    expect((await getDeliveries(event_id))[0]).toMatchObject({ status: "retrying", error_detail: "boom", response_status: null });
  });

  it("topic_filter: Treffer wird geliefert, Nichttreffer nicht (Event gilt als delivered)", async () => {
    const match = await addSub({ topic_filter: "order.created", url: "https://hooks.example.com/match" });
    await addSub({ topic_filter: "invoice.created", url: "https://hooks.example.com/other" });
    respond(204);
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "order.created", aggregate_id: "o", payload: {} }, { env: testEnv });
    await deliverEvent(testEnv, event_id);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://hooks.example.com/match");
    expect((await getDeliveries(event_id)).map((d) => d.subscription_id)).toEqual([match]);

    fetchMock.mockClear();
    const none = await emit({ tenant_id: tenant.tenant_id, topic: "stock.low", aggregate_id: "o", payload: {} }, { env: testEnv });
    await deliverEvent(testEnv, none.event_id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getEvent(none.event_id)).status).toBe("delivered");
    expect(await getDeliveries(none.event_id)).toHaveLength(0);
  });

  it("inaktive, geloeschte und fremde Subscriptions erhalten nichts", async () => {
    await addSub({ active: 0 });
    await addSub({ deleted_at: new Date().toISOString() });
    const other = await seedTenant({ slug: "outbox-delivery-other" });
    await addSub({ tenant_id: other.tenant_id });
    respond(200);
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "x.v1", aggregate_id: "o", payload: {} }, { env: testEnv });
    await deliverEvent(testEnv, event_id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ungueltige URL -> failed ohne fetch, Event bleibt im Retry-Zyklus", async () => {
    await addSub({ url: "http://localhost/internal" });
    const { event_id } = await emit({ tenant_id: tenant.tenant_id, topic: "x.v1", aggregate_id: "o", payload: {} }, { env: testEnv });
    await deliverEvent(testEnv, event_id);
    expect(fetchMock).not.toHaveBeenCalled();
    const dl = await getDeliveries(event_id);
    expect(dl[0]!.status).toBe("failed");
    expect(dl[0]!.error_detail).toMatch(/^url_invalid:/);
    expect(dl[0]!.response_status).toBeNull();
    expect((await getEvent(event_id)).status).toBe("retrying");
  });

  it("HARD_FAIL_CODES -> ack statt retry; sonstige Fehler -> retry", async () => {
    const hard = new CodedError("GH-TENANT-001");
    const soft = new Error("db down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingEnv = (e: Error) => ({ ...testEnv, DB: { prepare: () => { throw e; } } }) as unknown as Env;

    const a = batchOf("evt_x");
    await queueHandler(a.batch, failingEnv(hard));
    expect(a.msg.ack).toHaveBeenCalledOnce();
    expect(a.msg.retry).not.toHaveBeenCalled();

    const b = batchOf("evt_x");
    await queueHandler(b.batch, failingEnv(soft));
    expect(b.msg.retry).toHaveBeenCalledOnce();
    expect(b.msg.ack).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
