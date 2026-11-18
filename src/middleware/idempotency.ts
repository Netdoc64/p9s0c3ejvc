import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";
import { getDb } from "../db/client";
import { idempotency_locks } from "../db/schema/idempotency";

const TTL_SEC = 24 * 60 * 60;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const POLL_MS = 50;
const MAX_POLLS = 60; // ~3s wait

interface CacheEntry {
  status: number;
  body: string;
  content_type: string;
  payload_hash: string;
  headers?: Record<string, string>;
}

/**
 * Idempotency-Middleware.
 *
 * Zwei-Schicht-Architektur (Audit-Fix #I-001):
 * - **D1-Lock-Tabelle** (`idempotency_locks`): atomarer INSERT mit PK (tenant_id,key).
 *   Erster Request gewinnt, zweiter bekommt UNIQUE-Constraint-Violation und wartet
 *   per Polling auf den KV-Cache-Eintrag — kein Doppel-Handler-Run.
 * - **KV-Cache**: serialisierte 2xx-Response (24h TTL).
 *
 * Body-Hash: canonical JSON wenn Content-Type=application/json (#I-004).
 *
 * Fail-modes:
 * - DB-Failure beim Lock-Insert: durchlassen mit Warning (fail-open).
 * - KV-Failure: durchlassen mit Warning.
 */
export const idempotency = (): MiddlewareHandler<AppContext> => async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next();
  const rawKey = c.req.header("X-Idempotency-Key");
  if (!rawKey) return next();
  const tenantId = c.var.tenant_id ?? "_no_tenant";
  // Auf Kunden-Routen gehört der Schlüssel dem KUNDEN, nicht nur dem Tenant:
  // sonst bekäme Kunde B bei gleichem Schlüssel die gespeicherte Antwort von
  // Kunde A (fremde Bestellung, fremde Beträge).
  const key = c.var.customer_id ? `cust:${c.var.customer_id}:${rawKey}` : rawKey;

  const url = new URL(c.req.url);
  const rawBody = await c.req.raw.clone().text();
  const ct = c.req.header("Content-Type") ?? "";
  const canonicalBody = ct.startsWith("application/json") ? canonicalizeJson(rawBody) : rawBody;
  const payloadHash = await sha256Hex(`${c.req.method}\n${url.pathname}${url.search}\n${canonicalBody}`);
  const cacheKey = `idemp:${tenantId}:${key}`;

  // 1. KV-Hit-Path
  let cached: CacheEntry | null = null;
  try {
    cached = await c.env.KV.get<CacheEntry>(cacheKey, "json");
  } catch {
    c.res.headers.set("X-Idempotency-Warning", "kv_unavailable");
  }
  if (cached) return buildCachedResponse(cached, payloadHash, c.var.request_id);

  // 2. D1-Lock-Insert (#I-001)
  const db = getDb(c.env.DB);
  const nowIso = new Date().toISOString();
  let lockAcquired = false;
  try {
    await db.insert(idempotency_locks).values({
      tenant_id: tenantId,
      key,
      payload_hash: payloadHash,
      status: "in_flight",
      request_id: c.var.request_id,
      created_at: nowIso,
    });
    lockAcquired = true;
  } catch {
    // UNIQUE-Conflict (oder DB transient) → poll auf cache
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const c2 = await c.env.KV.get<CacheEntry>(cacheKey, "json");
        if (c2) return buildCachedResponse(c2, payloadHash, c.var.request_id);
      } catch { /* continue */ }
      // Lock-Status check: completed?
      const row = (await db.select().from(idempotency_locks).where(and(eq(idempotency_locks.tenant_id, tenantId), eq(idempotency_locks.key, key))).limit(1))[0];
      if (row && row.status === "completed") {
        // Cache might still be propagating; one more KV check
        try {
          const c3 = await c.env.KV.get<CacheEntry>(cacheKey, "json");
          if (c3) return buildCachedResponse(c3, payloadHash, c.var.request_id);
        } catch { /* fallthrough */ }
        // Cache-miss aber lock completed → 4xx-Response wurde nicht gecached. Replay durchlassen.
        if (row.payload_hash !== payloadHash) throw new CodedError("GH-IDEMP-001");
        c.res.headers.set("X-Idempotency-Warning", "completed_no_cache");
        return next();
      }
      if (row && row.payload_hash !== payloadHash) throw new CodedError("GH-IDEMP-001");
    }
    // Timeout → 409 (anderer Request läuft noch)
    throw new CodedError("GH-IDEMP-001", { reason: "in_flight_timeout" });
  }

  // 3. Handler ausführen
  await next();

  // 4. Bei 2xx in KV cachen + Lock auf completed
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    const respBody = await c.res.clone().text();
    const headersOut: Record<string, string> = {};
    c.res.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-length") headersOut[k] = v;
    });
    const entry: CacheEntry = {
      status,
      body: respBody,
      content_type: c.res.headers.get("Content-Type") ?? "application/json",
      payload_hash: payloadHash,
      headers: headersOut,
    };
    try {
      await c.env.KV.put(cacheKey, JSON.stringify(entry), { expirationTtl: TTL_SEC });
    } catch {
      c.res.headers.set("X-Idempotency-Warning", "kv_write_failed");
    }
  }
  if (lockAcquired) {
    try {
      await db.update(idempotency_locks)
        .set({ status: "completed", completed_at: new Date().toISOString() })
        .where(and(eq(idempotency_locks.tenant_id, tenantId), eq(idempotency_locks.key, key)));
    } catch { /* best-effort */ }
  }
  return;
};

function buildCachedResponse(cached: CacheEntry, payloadHash: string, request_id: string): Response {
  if (cached.payload_hash !== payloadHash) {
    throw new CodedError("GH-IDEMP-001");
  }
  const headers = new Headers();
  if (cached.headers) {
    for (const [k, v] of Object.entries(cached.headers)) headers.set(k, v);
  }
  headers.set("Content-Type", cached.content_type);
  headers.set("X-Idempotency-Hit", "true");
  headers.set("X-Request-Id", request_id);
  return new Response(cached.body, { status: cached.status, headers });
}

/**
 * Canonical JSON: deterministisch sortierte Keys.
 * Bei Parse-Fail → raw zurückgeben (Hash-stabil aber strikt).
 */
function canonicalizeJson(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return canonicalize(parsed);
  } catch {
    return raw;
  }
}

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}
