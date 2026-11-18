/**
 * M12 — Outbox + Webhook-Delivery
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { outbox_events, webhook_deliveries, webhook_subscriptions } from "../db/schema/webhooks";
import { newId } from "../lib/ids";
import { hmacSha256Hex } from "../lib/crypto";
import { validatePublicHttpsUrl } from "../lib/url-validation";

export interface EmitParams {
  tenant_id: string;
  topic: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

const BACKOFF_SEC = [1, 10, 60, 600, 3600, 21600];
const MAX_ATTEMPTS = BACKOFF_SEC.length;

/**
 * Deterministische JSON-Serialisierung für Webhook-Signing (#C-002).
 * Receiver MUST verify gegen den raw body bytes (nicht re-stringify),
 * dann ist diese Sortierung egal — aber sie macht die Signatur reproduzierbar
 * für Replay-Tests und Debug.
 */
function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJsonStringify).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}

export async function emit(params: EmitParams, opts: { env?: Env } = {}): Promise<{ event_id: string }> {
  // Audit-Fix #C-003: kein silent skip mehr — Caller-Bug surface'n.
  if (!opts.env) {
    throw new Error(`outbox.emit requires env (topic=${params.topic}, aggregate=${params.aggregate_id})`);
  }
  const env = opts.env;
  const db = getDb(env.DB);
  const event_id = newId("event");
  const now = new Date().toISOString();
  await db.insert(outbox_events).values({
    id: event_id,
    tenant_id: params.tenant_id,
    topic: params.topic,
    aggregate_id: params.aggregate_id,
    payload: JSON.stringify(params.payload),
    status: "pending",
    attempt: 0,
    created_at: now,
  });
  // Versuche sofort die Queue zu nutzen, sonst läuft der Sweeper nach.
  try {
    await env.OUTBOX_QUEUE.send({ event_id });
  } catch {
    // OK, sweeper holt es
  }
  return { event_id };
}

export async function deliverEvent(env: Env, event_id: string): Promise<void> {
  const db = getDb(env.DB);
  const events = await db.select().from(outbox_events).where(eq(outbox_events.id, event_id)).limit(1);
  const evt = events[0];
  if (!evt) return;
  if (evt.status === "delivered" || evt.status === "dead_letter") return;

  const subs = await db.select().from(webhook_subscriptions).where(and(
    eq(webhook_subscriptions.tenant_id, evt.tenant_id),
    eq(webhook_subscriptions.active, 1),
    isNull(webhook_subscriptions.deleted_at),
  ));
  const matchingSubs = subs.filter((s) => s.topic_filter === "*" || s.topic_filter === evt.topic);

  if (matchingSubs.length === 0) {
    await db.update(outbox_events).set({ status: "delivered", delivered_at: new Date().toISOString() }).where(eq(outbox_events.id, event_id));
    return;
  }

  const attempt = evt.attempt + 1;
  let allSuccess = true;
  for (const sub of matchingSubs) {
    // Defense-in-Depth gegen SSRF: bei delivery nochmal validieren (#T-005),
    // falls die URL durch Schema-Drift jemals doch ungültig sein sollte.
    const urlOk = validatePublicHttpsUrl(sub.url);
    if (!urlOk.ok) {
      await db.insert(webhook_deliveries).values({
        id: newId("event"),
        event_id: evt.id,
        subscription_id: sub.id,
        status: "failed",
        attempt,
        response_status: null,
        latency_ms: 0,
        error_detail: `url_invalid:${urlOk.reason}`,
        created_at: new Date().toISOString(),
      });
      allSuccess = false;
      continue;
    }
    // Webhook-Replay-Schutz (#C-001): Timestamp + Body in Signing-String.
    // Body bleibt canonical-stringified (#C-002) — sortierte Keys.
    const deliveryTs = Math.floor(Date.now() / 1000).toString();
    const bodyObj = {
      event_id: evt.id,
      topic: evt.topic,
      occurred_at: evt.created_at,
      tenant_id: evt.tenant_id,
      aggregate_id: evt.aggregate_id,
      payload: JSON.parse(evt.payload),
    };
    const body = canonicalJsonStringify(bodyObj);
    const signingString = `${deliveryTs}.${body}`;
    const signature = await hmacSha256Hex(sub.signing_secret, signingString);
    const deliveryStart = performance.now();
    let status: "delivered" | "failed" | "retrying" = "failed";
    let responseStatus: number | undefined;
    let errorDetail: string | undefined;
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grosshandel-Event": evt.topic,
          "X-Grosshandel-Signature": `sha256=${signature}`,
          "X-Grosshandel-Timestamp": deliveryTs,
          "X-Grosshandel-Idempotency-Key": evt.id,
          "X-Grosshandel-Delivery-Attempt": String(attempt),
          "X-Grosshandel-Event-Version": evt.topic.split(".").pop() ?? "v1",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        status = "delivered";
      } else {
        status = attempt < MAX_ATTEMPTS ? "retrying" : "failed";
        errorDetail = `http ${res.status}`;
      }
    } catch (err) {
      errorDetail = err instanceof Error ? err.message : String(err);
      status = attempt < MAX_ATTEMPTS ? "retrying" : "failed";
    }
    const latency = Math.round(performance.now() - deliveryStart);
    await db.insert(webhook_deliveries).values({
      id: newId("event"),
      event_id: evt.id,
      subscription_id: sub.id,
      status,
      attempt,
      response_status: responseStatus ?? null,
      latency_ms: latency,
      error_detail: errorDetail ?? null,
      created_at: new Date().toISOString(),
    });
    if (status !== "delivered") allSuccess = false;
  }

  if (allSuccess) {
    await db.update(outbox_events).set({ status: "delivered", attempt, delivered_at: new Date().toISOString() }).where(eq(outbox_events.id, evt.id));
    return;
  }
  if (attempt >= MAX_ATTEMPTS) {
    await db.update(outbox_events).set({ status: "dead_letter", attempt }).where(eq(outbox_events.id, evt.id));
    return;
  }
  // attempt ist 1-basiert: der erste Retry (nach Versuch 1) nutzt BACKOFF_SEC[0].
  const backoff = BACKOFF_SEC[attempt - 1] ?? BACKOFF_SEC[BACKOFF_SEC.length - 1] as number;
  const retryAt = new Date(Date.now() + backoff * 1000).toISOString();
  await db.update(outbox_events).set({ status: "retrying", attempt, retry_at: retryAt }).where(eq(outbox_events.id, evt.id));
  try {
    await env.OUTBOX_QUEUE.send({ event_id: evt.id }, { delaySeconds: backoff });
  } catch {
    /* sweeper picks up */
  }
}

/**
 * Outbox-Sweep mit Tenant-Fairness (#C-009).
 *
 * Statt nach created_at zu sortieren (bevorzugt einen einzigen großen Tenant):
 * round-robin pro Tenant — jeder Tenant bekommt MAX_PER_TENANT Slots pro Sweep.
 * Verhindert Noisy-Neighbor-DoS auf den Sweeper.
 */
const SWEEP_MAX_PER_TENANT = 20;
const SWEEP_TOTAL_CAP = 200;

export async function sweepStuck(env: Env): Promise<{ swept: number }> {
  const db = getDb(env.DB);
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const nowIso = new Date().toISOString();
  // Hole alle in-Frage-kommenden, dann filter per-tenant.
  const pending = await db.select().from(outbox_events).where(and(eq(outbox_events.status, "pending"), lt(outbox_events.created_at, cutoff))).limit(SWEEP_TOTAL_CAP * 2);
  const retrying = await db.select().from(outbox_events).where(and(eq(outbox_events.status, "retrying"), lt(outbox_events.retry_at, nowIso))).limit(SWEEP_TOTAL_CAP * 2);
  const all = [...pending, ...retrying];

  // Group nach tenant_id und nehme max N pro Tenant.
  const perTenant = new Map<string, typeof all>();
  for (const e of all) {
    const arr = perTenant.get(e.tenant_id) ?? [];
    if (arr.length < SWEEP_MAX_PER_TENANT) arr.push(e);
    perTenant.set(e.tenant_id, arr);
  }
  const fair: typeof all = [];
  for (const arr of perTenant.values()) fair.push(...arr);
  const limited = fair.slice(0, SWEEP_TOTAL_CAP);

  for (const evt of limited) {
    try { await env.OUTBOX_QUEUE.send({ event_id: evt.id }); } catch { /* ignore */ }
  }
  return { swept: limited.length };
}
