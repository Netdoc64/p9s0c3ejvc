import { describe, expect, it } from "vitest";
import { HANDLERS } from "../../src/orchestrator/handlers";
import { isInternalStep } from "../../src/orchestrator/state-machine";
import type { OrderDoc } from "../../src/schemas/order";

const doc = {
  meta: { schema_version: "order-document/1.0", doc_type: "order", id: "ord_test", tenant_id: "t_test" },
  state: { current: "confirmed", history: [] },
  plan: { next_steps: [], executed_steps: [] },
  external_refs: {},
} as unknown as OrderDoc;

describe("emit_event", () => {
  it("legt das Event für den atomaren Outbox-Insert ab, statt es selbst zu schreiben", async () => {
    const step = { id: "s1", type: "emit_event" as const, args: { topic: "order.confirmed.v1" } };
    const { doc: next } = await HANDLERS.emit_event(doc, { env: {} as never, step, now: new Date().toISOString() });
    const pending = (next.external_refs as Record<string, unknown>)._pending_emits as Array<{ topic: string; payload: { meta: { id: string } } }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.topic).toBe("order.confirmed.v1");
    expect(pending[0]?.payload.meta.id).toBe("ord_test");
  });

  it("hängt an statt zu ersetzen, wenn schon ein Event wartet", async () => {
    const withOne = { ...doc, external_refs: { _pending_emits: [{ topic: "a", payload: {} }] } } as unknown as OrderDoc;
    const step = { id: "s2", type: "emit_event" as const, args: { topic: "b" } };
    const { doc: next } = await HANDLERS.emit_event(withOne, { env: {} as never, step, now: new Date().toISOString() });
    const pending = (next.external_refs as Record<string, unknown>)._pending_emits as Array<{ topic: string }>;
    expect(pending.map((p) => p.topic)).toEqual(["a", "b"]);
  });
});

describe("Auto-Chain", () => {
  it("läuft nach der Bestätigung bis zur Rechnung durch", () => {
    // confirm plant commit_stock → emit_event → generate_invoice; bricht einer
    // davon die Kette, setzt sie nichts fort (runNextStep hat keinen Sweeper).
    for (const t of ["commit_stock", "emit_event", "generate_invoice"]) {
      expect(isInternalStep(t), t).toBe(true);
    }
  });

  it("hält bei der Nutzerbestätigung an", () => {
    expect(isInternalStep("await_confirmation")).toBe(false);
  });
});
