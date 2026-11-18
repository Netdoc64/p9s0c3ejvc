import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface Reservation {
  reservation_id: string;
  qty: number;
  expires_at: number; // ms epoch
  idempotency_key?: string;
  customer_id?: string;
}

interface PendingMovement {
  type: "reserve" | "commit" | "release" | "auto_release" | "adjust";
  qty_delta: number;
  reservation_id?: string;
  reason?: string;
  actor_id?: string;
  ts: string;
}

interface DOState {
  available: number;
  reservations: Record<string, Reservation>;
  pending_movements: PendingMovement[];
  schema_version: 1;
  /** "tenant_id/warehouse_id/sku_id" — beim ersten Aufruf gesetzt für Movements-Audit. */
  scope?: { tenant_id: string; warehouse_id: string; sku_id: string };
  /** Idempotency-Cache für adjust+commit (#S-007). Sliding 1h-Window. */
  idempotency_cache?: Record<string, { result: unknown; ts: number }>;
}

const DEFAULT_STATE: DOState = {
  available: 0,
  reservations: {},
  pending_movements: [],
  schema_version: 1,
};

export class StockDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    // Atomare read-modify-write für ALLE state-mutierenden Pfade (#S-002).
    // Read-only Pfad /state nutzt blockConcurrencyWhile nicht — nur die Snapshot-Lesung.
    return await this.ctx.blockConcurrencyWhile(async () => this.handleFetch(req));
  }

  private async handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname;
    const state = (await this.ctx.storage.get<DOState>("state")) ?? { ...DEFAULT_STATE };

    if (action === "/scope") {
      const body = (await req.json()) as { tenant_id: string; warehouse_id: string; sku_id: string };
      state.scope = body;
      await this.ctx.storage.put("state", state);
      return Response.json({ ok: true });
    }

    if (action === "/state") {
      return Response.json(this.publicSnapshot(state));
    }

    if (action === "/return-stock") {
      const body = await req.json<{ movement_id: string; qty: number }>();
      const key = `return-stock:${body.movement_id}`;
      const booked = await this.ctx.storage.get<number>(key);
      if (booked !== undefined) return Response.json({ booked }, { status: booked === body.qty ? 200 : 409 });
      state.available += body.qty;
      state.pending_movements.push({
        type: "adjust", qty_delta: body.qty, reason: key, ts: new Date().toISOString(),
      });
      await this.ctx.storage.put({ state, [key]: body.qty });
      return Response.json({ booked: body.qty });
    }

    if (action === "/adjust") {
      const body = (await req.json()) as { qty_delta: number; reason?: string; actor_id?: string; idempotency_key?: string };
      // Idempotency (#S-007): zweiter Call mit gleichem Key → kein Doppel-Adjust.
      if (body.idempotency_key) {
        const cached = pruneAndGet(state, `adj:${body.idempotency_key}`);
        if (cached) return Response.json(cached);
      }
      state.available += body.qty_delta;
      state.pending_movements.push({
        type: "adjust", qty_delta: body.qty_delta, reason: body.reason, actor_id: body.actor_id, ts: new Date().toISOString(),
      });
      const result = { available: state.available, idempotent: false };
      if (body.idempotency_key) cacheSet(state, `adj:${body.idempotency_key}`, { ...result, idempotent: true });
      await this.ctx.storage.put("state", state);
      return Response.json(result);
    }

    if (action === "/reserve") {
      const body = (await req.json()) as { qty: number; ttl_sec: number; idempotency_key?: string; customer_id?: string };
      // idempotency
      if (body.idempotency_key) {
        for (const r of Object.values(state.reservations)) {
          if (r.idempotency_key === body.idempotency_key) {
            return Response.json({ reservation_id: r.reservation_id, expires_at: new Date(r.expires_at).toISOString(), idempotent: true });
          }
        }
      }
      const sumReservations = Object.values(state.reservations).reduce((acc, r) => acc + r.qty, 0);
      if (state.available - sumReservations < body.qty) {
        return Response.json({ error: "GH-STOCK-001", available: state.available - sumReservations }, { status: 409 });
      }
      const reservation_id = `res_${randomUlid()}`;
      const expires_at = Date.now() + body.ttl_sec * 1000;
      state.reservations[reservation_id] = {
        reservation_id, qty: body.qty, expires_at,
        idempotency_key: body.idempotency_key,
        customer_id: body.customer_id,
      };
      state.pending_movements.push({
        type: "reserve", qty_delta: 0, reservation_id, ts: new Date().toISOString(), actor_id: body.customer_id,
      });
      await this.ctx.storage.put("state", state);
      const next = nextAlarm(state);
      if (next) await this.ctx.storage.setAlarm(next);
      return Response.json({ reservation_id, expires_at: new Date(expires_at).toISOString() });
    }

    if (action === "/commit") {
      const body = (await req.json()) as { reservation_id: string; idempotency_key?: string };
      // Idempotency (#S-007): doppel-commit mit gleichem Key → cached result.
      if (body.idempotency_key) {
        const cached = pruneAndGet(state, `cmt:${body.idempotency_key}`);
        if (cached) return Response.json(cached);
      }
      const r = state.reservations[body.reservation_id];
      if (!r) return Response.json({ error: "GH-STOCK-002" }, { status: 410 });
      state.available -= r.qty;
      delete state.reservations[body.reservation_id];
      state.pending_movements.push({
        type: "commit", qty_delta: -r.qty, reservation_id: body.reservation_id, ts: new Date().toISOString(),
      });
      const result = { available: state.available, committed_qty: r.qty, idempotent: false };
      if (body.idempotency_key) cacheSet(state, `cmt:${body.idempotency_key}`, { ...result, idempotent: true });
      await this.ctx.storage.put("state", state);
      return Response.json(result);
    }

    if (action === "/release") {
      const body = (await req.json()) as { reservation_id: string };
      const r = state.reservations[body.reservation_id];
      if (r) {
        delete state.reservations[body.reservation_id];
        state.pending_movements.push({
          type: "release", qty_delta: 0, reservation_id: body.reservation_id, ts: new Date().toISOString(),
        });
        await this.ctx.storage.put("state", state);
      }
      return Response.json({ released: !!r });
    }

    if (action === "/rebuild") {
      // Nur per Stub erreichbar (services/stock-rebuild.ts), keine Route reicht das nach außen.
      // DR: Zustand aus stock_movements neu setzen; offene Reservierungen und
      // nicht gedrainte Bewegungen gehen verloren (D1 ist die Quelle).
      const body = (await req.json()) as { available: number; scope: NonNullable<DOState["scope"]>; force?: boolean };
      if (!Number.isInteger(body.available) || !body.scope) return Response.json({ error: "bad rebuild body" }, { status: 400 });
      const existing = await this.ctx.storage.get<DOState>("state");
      const same = existing !== undefined && existing.available === body.available
        && Object.keys(existing.reservations).length === 0 && existing.pending_movements.length === 0
        && existing.scope?.tenant_id === body.scope.tenant_id && existing.scope?.warehouse_id === body.scope.warehouse_id
        && existing.scope?.sku_id === body.scope.sku_id;
      if (same) return Response.json({ available: body.available, changed: false });
      if (existing && !body.force) return Response.json({ error: "GH-STOCK-REBUILD-EXISTS", available: existing.available }, { status: 409 });
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("state", {
        available: body.available, reservations: {}, pending_movements: [], schema_version: 1, scope: body.scope,
      } satisfies DOState);
      return Response.json({ available: body.available, changed: true });
    }

    if (action === "/drain-movements") {
      const items = state.pending_movements.slice();
      state.pending_movements = [];
      await this.ctx.storage.put("state", state);
      return Response.json({ items, scope: state.scope });
    }

    return new Response("not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<DOState>("state")) ?? { ...DEFAULT_STATE };
    const now = Date.now();
    let cleaned = 0;
    for (const [id, r] of Object.entries(state.reservations)) {
      if (r.expires_at <= now) {
        delete state.reservations[id];
        state.pending_movements.push({
          type: "auto_release", qty_delta: 0, reservation_id: id, ts: new Date().toISOString(),
        });
        cleaned += 1;
      }
    }
    if (cleaned > 0) await this.ctx.storage.put("state", state);
    const next = nextAlarm(state);
    if (next) await this.ctx.storage.setAlarm(next);
  }

  private publicSnapshot(s: DOState): { available: number; reserved: number; reservations: number; scope: DOState["scope"] } {
    const reserved = Object.values(s.reservations).reduce((a, r) => a + r.qty, 0);
    return { available: s.available, reserved, reservations: Object.keys(s.reservations).length, scope: s.scope };
  }
}

/** Idempotency-TTL: 1h sliding window. Älter wird beim Lesen geprunt. */
const IDEMP_TTL_MS = 60 * 60 * 1000;

function pruneAndGet(state: DOState, key: string): unknown | null {
  if (!state.idempotency_cache) return null;
  const now = Date.now();
  // Prune ältere Einträge defensiv (cap).
  for (const [k, v] of Object.entries(state.idempotency_cache)) {
    if (now - v.ts > IDEMP_TTL_MS) delete state.idempotency_cache[k];
  }
  return state.idempotency_cache[key]?.result ?? null;
}

function cacheSet(state: DOState, key: string, result: unknown): void {
  if (!state.idempotency_cache) state.idempotency_cache = {};
  state.idempotency_cache[key] = { result, ts: Date.now() };
}

function nextAlarm(s: DOState): number | undefined {
  let min = Infinity;
  for (const r of Object.values(s.reservations)) {
    if (r.expires_at < min) min = r.expires_at;
  }
  return min === Infinity ? undefined : min;
}

function randomUlid(): string {
  // Edge-/Workers-fähiger Mini-ULID-Generator; reicht für DO-interne IDs.
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const t = Date.now();
  let ts = t;
  const tsCh: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) { tsCh[i] = ENC[ts % 32] as string; ts = Math.floor(ts / 32); }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let out = tsCh.join("");
  for (let i = 0; i < 16; i++) out += ENC[(rnd[i] as number) % 32];
  return out;
}
