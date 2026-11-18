import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";

/**
 * Token-Bucket Rate-Limit (KV-backed). Konfiguration via cross_cutting:
 * default_buckets_per_minute: { auth_login: 5, auth_token_refresh: 60, ... }
 *
 * Strikte Klassen (auth_login, auth_token_refresh, magic_link_request) MÜSSEN
 * DO-backed sein, weil KV eventual-consistent ist. Hier: KV als v1-Default,
 * DO-Variante als Plan-Revision-Kandidat (siehe M15-Spec).
 *
 * Fail-Open: KV-Outage → durchlassen mit Warning-Header (Spec).
 */

export type RateLimitClass =
  | "auth_login"
  | "auth_token_refresh"
  | "magic_link_request"
  | "read_hot"
  | "read_warm"
  | "write_safe"
  | "write_critical";

export const DEFAULT_LIMITS: Record<RateLimitClass, number> = {
  auth_login: 5,
  auth_token_refresh: 60,
  magic_link_request: 3,
  read_hot: 600,
  read_warm: 120,
  write_safe: 60,
  write_critical: 20,
};

/**
 * Audit-Fix #I-005: alle Klassen DO-backed (single-writer, konsistent).
 * KV-Path bleibt nur als Fallback bei DO-Outage erhalten.
 */
const STRICT_CLASSES = new Set<RateLimitClass>([
  "auth_login", "auth_token_refresh", "magic_link_request",
  "read_hot", "read_warm", "write_safe", "write_critical",
]);

const TIER_MULTIPLIERS = { free: 1, starter: 3, pro: 10, enterprise: 30 };

export interface RateLimitOptions {
  class: RateLimitClass;
  /** Override für default_buckets_per_minute. */
  perMinute?: number;
  /** Funktion die den Bucket-Identifier baut (Default: tenant_id + customer_id + ip). */
  identify?: (c: import("hono").Context<AppContext>) => string;
}

interface BucketState {
  count: number;
  reset_at: number;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const limit = opts.perMinute ?? DEFAULT_LIMITS[opts.class];
    const ident = opts.identify ? opts.identify(c) : defaultIdentifier(c);
    const isStrict = STRICT_CLASSES.has(opts.class);
    // RATE_LIMIT_DO ist seit #C-012 required; Cast wegen Workers-vs-DOM-Type-Mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doNs = (c.env as any).RATE_LIMIT_DO as DurableObjectNamespace | undefined;

    // Strict + DO verfügbar → Single-Writer-Path
    if (isStrict && doNs) {
      const stub = doNs.get(doNs.idFromName(`rl:${opts.class}:${ident}`));
      try {
        const res = await stub.fetch("https://rl.local/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit, window_sec: 60 }),
        });
        const r = (await res.json()) as { allowed: boolean; remaining: number; reset_at: number; retry_after: number };
        c.res.headers.set("X-RateLimit-Limit", String(limit));
        c.res.headers.set("X-RateLimit-Remaining", String(r.remaining));
        c.res.headers.set("X-RateLimit-Reset", String(r.reset_at));
        if (!r.allowed) {
          c.res.headers.set("Retry-After", String(r.retry_after));
          throw new CodedError("GH-RATE-001", { class: opts.class, limit, strict: true });
        }
        await next();
        return;
      } catch (err) {
        if (err instanceof CodedError) throw err;
        // DO unreachable: fail-open mit Warning + KV-Fallback
        c.res.headers.set("X-RateLimit-Warning", "do_unavailable_fallback_kv");
      }
    }

    // KV-Path (default + strict-fallback)
    const minute = Math.floor(Date.now() / 60_000);
    const key = `rl:${opts.class}:${ident}:${minute}`;
    let state: BucketState | null = null;
    try {
      state = await c.env.KV.get<BucketState>(key, "json");
    } catch {
      c.res.headers.set("X-RateLimit-Warning", "kv_unavailable");
      return next();
    }
    const next_state: BucketState = state ?? { count: 0, reset_at: (minute + 1) * 60 };
    next_state.count += 1;
    c.res.headers.set("X-RateLimit-Limit", String(limit));
    c.res.headers.set("X-RateLimit-Remaining", String(Math.max(0, limit - next_state.count)));
    c.res.headers.set("X-RateLimit-Reset", String(next_state.reset_at));
    if (next_state.count > limit) {
      const retry = next_state.reset_at - Math.floor(Date.now() / 1000);
      c.res.headers.set("Retry-After", String(Math.max(1, retry)));
      throw new CodedError("GH-RATE-001", { class: opts.class, limit });
    }
    try {
      await c.env.KV.put(key, JSON.stringify(next_state), { expirationTtl: 90 });
    } catch {
      c.res.headers.set("X-RateLimit-Warning", "kv_write_failed");
    }
    await next();
  };
}

function defaultIdentifier(c: import("hono").Context<AppContext>): string {
  const tenant = c.var.tenant_id ?? "_anon_t";
  const customer = c.var.customer_id ?? "_anon_c";
  const ip = c.req.header("CF-Connecting-IP") ?? "_no_ip";
  return `${tenant}/${customer}/${ip}`;
}

export { TIER_MULTIPLIERS };
