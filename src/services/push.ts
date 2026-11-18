/**
 * M23 — Push-Notifications.
 * v1: Adapter-Stubs für APNs (HTTP/2) + FCM v1. Echter Provider-Call ist Plan-Revision-Kandidat
 * sobald Tenant Apple-Team-ID + FCM-Server-Key konfiguriert hat.
 *
 * Throttle: max 5 Pushes pro Customer pro Minute.
 * Quiet-Hours: 22-7 (Customer-Timezone). Nicht-kritische Events werden in Quiet-Hours unterdrückt.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { devices } from "../db/schema/devices";

export interface PushParams {
  tenant_id: string;
  customer_id: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Wenn `true`, wird Quiet-Hours ignoriert (z.B. Order-Confirmed). */
  bypass_quiet_hours?: boolean;
}

const THROTTLE_PER_MIN = 5;

export async function sendToCustomer(env: Env, params: PushParams): Promise<{ sent: number; throttled: boolean }> {
  const db = getDb(env.DB);
  // Throttle via KV
  const minute = Math.floor(Date.now() / 60_000);
  const throttleKey = `push:throttle:${params.customer_id}:${minute}`;
  let count = 0;
  try { count = (await env.KV.get<number>(throttleKey, "json")) ?? 0; } catch { /* fail-open */ }
  if (count >= THROTTLE_PER_MIN) return { sent: 0, throttled: true };

  // Quiet-Hours: vereinfacht 22-7 lokal — wir brauchen Customer-Timezone-Lookup
  // (in v1 nicht modelliert auf customers). Plan-Revision-Kandidat.
  // Hier: kein Quiet-Hours-Check ohne TZ-Daten.

  // Tenant-Filter (#T-004) — Defense-in-Depth gegen ULID-Kollision.
  const activeDevices = await db.select().from(devices).where(and(eq(devices.tenant_id, params.tenant_id), eq(devices.customer_id, params.customer_id), eq(devices.active, 1)));
  if (activeDevices.length === 0) return { sent: 0, throttled: false };

  let sent = 0;
  for (const d of activeDevices) {
    try {
      // Stub: echte APNs/FCM-Calls sind Plan-Revision-Kandidat. v1 emittet structured log.
      console.log(JSON.stringify({ event: "push.send_stub", platform: d.platform, customer_id: params.customer_id, title: params.title }));
      sent += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: "push.error", error: err instanceof Error ? err.message : String(err) }));
    }
  }
  try { await env.KV.put(throttleKey, JSON.stringify(count + sent), { expirationTtl: 90 }); } catch { /* ignore */ }
  return { sent, throttled: false };
}

export async function invalidateToken(env: Env, push_token: string, tenant_id?: string): Promise<void> {
  const db = getDb(env.DB);
  // Wenn tenant_id gegeben, scope auf Tenant; sonst global (z.B. APNs-feedback ohne Tenant-Kontext).
  if (tenant_id) {
    await db.update(devices).set({ active: 0 }).where(and(eq(devices.push_token, push_token), eq(devices.tenant_id, tenant_id)));
  } else {
    await db.update(devices).set({ active: 0 }).where(eq(devices.push_token, push_token));
  }
}
