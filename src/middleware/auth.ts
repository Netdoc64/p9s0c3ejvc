import type { MiddlewareHandler } from "hono";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { AppContext } from "../env";
import { CodedError } from "../errors/catalog";
import { getDb } from "../db/client";
import { api_keys, tenants } from "../db/schema/tenants";
import { hmacSha256Verify, sha256Hex } from "../lib/crypto";

const SKEW_TOLERANCE_SEC = 300;

/**
 * Auth-Middleware: X-Api-Key + X-Signature + X-Timestamp
 * Setzt c.var.tenant_id + c.var.api_key_id bei Erfolg, sonst CodedError.
 *
 * HMAC-Signing-String:
 *   <method>\n<path-with-search>\n<timestamp>\n<body-sha256-hex>
 *
 * `path-with-search` = `url.pathname + url.search` (inkl. Query-String).
 * Audit-Fix #A-002: Query-String muss signiert werden, damit Filter-Parameter
 * (limit, customer_id, state) nicht tampern-bar sind.
 *
 * Doppel-Reader: akzeptiert Plus key_hash_previous + hmac_secret_previous während
 * 7d-Karenz nach Rotation (M16). Indexed Lookup über UNION beider Spalten —
 * kein Full-Table-Scan.
 */
export const auth = (): MiddlewareHandler<AppContext> => async (c, next) => {
  const apiKeyHeader = c.req.header("X-Api-Key");
  const signatureHeader = c.req.header("X-Signature");
  const timestampHeader = c.req.header("X-Timestamp");

  if (!apiKeyHeader) throw new CodedError("GH-AUTH-001");
  if (!signatureHeader) throw new CodedError("GH-AUTH-002");
  if (!timestampHeader) throw new CodedError("GH-AUTH-003");

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) throw new CodedError("GH-AUTH-003");
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SKEW_TOLERANCE_SEC) throw new CodedError("GH-AUTH-003");

  const keyHash = await sha256Hex(apiKeyHeader);
  const nowIso = new Date().toISOString();
  const db = getDb(c.env.DB);

  // Indexed Doppel-Reader: matched current key_hash ODER previous key_hash innerhalb Karenz.
  // Beide Spalten haben Indizes (idx_api_keys_hash + key_hash_previous via PK-Index-Plan).
  const rows = await db
    .select({
      id: api_keys.id,
      tenant_id: api_keys.tenant_id,
      key_hash: api_keys.key_hash,
      key_hash_previous: api_keys.key_hash_previous,
      key_hash_previous_until: api_keys.key_hash_previous_until,
      hmac_secret: api_keys.hmac_secret,
      hmac_secret_previous: api_keys.hmac_secret_previous,
      hmac_secret_previous_until: api_keys.hmac_secret_previous_until,
      scope: api_keys.scope,
      tenant_status: tenants.status,
    })
    .from(api_keys)
    .innerJoin(tenants, eq(tenants.id, api_keys.tenant_id))
    .where(and(
      isNull(api_keys.revoked_at),
      isNull(tenants.deleted_at),
      or(
        eq(api_keys.key_hash, keyHash),
        and(eq(api_keys.key_hash_previous, keyHash), gt(api_keys.key_hash_previous_until, nowIso)),
      ),
    ))
    .limit(1);

  const found = rows[0];
  if (!found || found.tenant_status !== "active") throw new CodedError("GH-AUTH-001");

  const url = new URL(c.req.url);
  let bodyHash: string;
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    bodyHash = await sha256Hex("");
  } else {
    const buf = await c.req.raw.clone().arrayBuffer();
    bodyHash = await sha256Hex(new Uint8Array(buf));
  }
  const signingString = `${c.req.method}\n${url.pathname}${url.search}\n${timestampHeader}\n${bodyHash}`;

  // HMAC-Verify: akzeptiert current ODER previous-Secret während Karenz.
  let ok = await hmacSha256Verify(found.hmac_secret, signingString, signatureHeader);
  if (!ok && found.hmac_secret_previous && found.hmac_secret_previous_until && found.hmac_secret_previous_until > nowIso) {
    ok = await hmacSha256Verify(found.hmac_secret_previous, signingString, signatureHeader);
  }
  if (!ok) throw new CodedError("GH-AUTH-002");

  // Replay-Cache (#A-014): innerhalb des Skew-Windows darf jede Signatur nur 1× greifen.
  // ABER: Idempotency-Layer behandelt explizite Wiederholungen (X-Idempotency-Key).
  // Wenn ein Idempotency-Key gesetzt ist, übernimmt die Idempotency-Middleware
  // den De-Duplication-Job; replay-cache würde nur stören.
  // Schutz greift nur für Requests OHNE Idempotency-Key.
  //
  // UND NUR FÜR SCHREIBENDE METHODEN. Zwei identische GETs in derselben Sekunde
  // tragen dieselbe Signatur — der Replay-Cache wies den zweiten mit 401 ab
  // (Lasttest 2026-11-17: 47 % der Suchanfragen). Ein wiederholter Lesezugriff
  // ändert nichts, und jeder Lesezugriff kostete einen KV-Schreibvorgang.
  const idempotencyHeader = c.req.header("X-Idempotency-Key");
  const safeMethod = c.req.method === "GET" || c.req.method === "HEAD";
  if (!idempotencyHeader && !safeMethod) {
    try {
      const replayKey = `replay:${await sha256Hex(`${apiKeyHeader}:${signatureHeader}:${timestampHeader}`)}`;
      const seen = await c.env.KV.get(replayKey);
      if (seen) throw new CodedError("GH-AUTH-002", { reason: "replay_detected" });
      await c.env.KV.put(replayKey, "1", { expirationTtl: SKEW_TOLERANCE_SEC * 2 });
    } catch (err) {
      if (err instanceof CodedError) throw err;
      c.res.headers.set("X-Auth-Warning", "replay_cache_unavailable");
    }
  }

  c.set("tenant_id", found.tenant_id);
  c.set("api_key_id", found.id);
  c.set("api_key_scope", found.scope);
  await next();
};
