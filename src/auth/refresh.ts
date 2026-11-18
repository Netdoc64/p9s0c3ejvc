import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { auth_refresh_tokens } from "../db/schema/auth";
import { customers } from "../db/schema/customers";
import { sha256Hex, randomSecret } from "../lib/crypto";
import { newId } from "../lib/ids";
import { CodedError } from "../errors/catalog";

const REFRESH_TTL_SEC = 90 * 24 * 60 * 60;

export interface IssueParams {
  tenant_id: string;
  customer_id: string;
  scope: string[];
  client_id?: string;
  parent_id?: string;
  family_id?: string;
}

export interface IssuedRefresh {
  id: string;
  plain: string;
  family_id: string;
  expires_at: string;
}

export async function issueRefresh(db: DB, params: IssueParams): Promise<IssuedRefresh> {
  const id = newId("event");
  const plain = `gr_${randomSecret(32)}`;
  const token_hash = await sha256Hex(plain);
  const now = new Date();
  const expires_at = new Date(now.getTime() + REFRESH_TTL_SEC * 1000).toISOString();
  const family_id = params.family_id ?? newId("event");
  await db.insert(auth_refresh_tokens).values({
    id,
    tenant_id: params.tenant_id,
    customer_id: params.customer_id,
    token_hash,
    client_id: params.client_id ?? null,
    scope: params.scope.join(" "),
    parent_id: params.parent_id ?? null,
    family_id,
    issued_at: now.toISOString(),
    expires_at,
  });
  return { id, plain, family_id, expires_at };
}

export interface RotateResult {
  new_refresh: IssuedRefresh;
  customer_id: string;
  tenant_id: string;
  scope: string[];
}

/**
 * Refresh-Token-Rotation mit Replay-Detection:
 *   - Token muss aktiv (nicht revoked, nicht rotated, nicht expired) sein
 *   - Bei Replay (rotated_at gesetzt aber wieder eingereicht) → ALLE Tokens
 *     der gleichen `family_id` revoken (Anomalie) → GH-AUTH-007
 *   - Erfolg: alter Token wird `rotated_at` markiert; neuer Token mit gleichem family_id
 */
export async function rotateRefresh(db: DB, plain: string): Promise<RotateResult> {
  const token_hash = await sha256Hex(plain);
  const rows = await db.select().from(auth_refresh_tokens).where(eq(auth_refresh_tokens.token_hash, token_hash)).limit(1);
  const found = rows[0];
  if (!found) throw new CodedError("GH-AUTH-005");
  if (found.revoked_at) throw new CodedError("GH-AUTH-005");
  if (found.rotated_at) {
    // Replay! → Familie revoken
    const now = new Date().toISOString();
    await db.update(auth_refresh_tokens)
      .set({ revoked_at: now, revoke_reason: "replay_detected" })
      .where(and(eq(auth_refresh_tokens.family_id, found.family_id), isNull(auth_refresh_tokens.revoked_at)));
    throw new CodedError("GH-AUTH-007");
  }
  if (new Date(found.expires_at).getTime() < Date.now()) throw new CodedError("GH-AUTH-005");

  // Customer-Status zur Refresh-Zeit re-resolven (#A-007): wenn blocked oder gelöscht,
  // Family-Revoke und reject. Verhindert Privilege-Persistence nach Sperre.
  const cs = await db.select({ blocked: customers.blocked, deleted_at: customers.deleted_at })
    .from(customers)
    .where(and(eq(customers.id, found.customer_id), eq(customers.tenant_id, found.tenant_id)))
    .limit(1);
  const cust = cs[0];
  if (!cust || cust.deleted_at || cust.blocked === 1) {
    const revokeNow = new Date().toISOString();
    await db.update(auth_refresh_tokens)
      .set({ revoked_at: revokeNow, revoke_reason: "customer_blocked_or_deleted" })
      .where(and(eq(auth_refresh_tokens.family_id, found.family_id), isNull(auth_refresh_tokens.revoked_at)));
    throw new CodedError("GH-AUTH-005");
  }

  // Atomare Rotation (#A-009): nur wenn rotated_at IS NULL — sonst hat ein paralleler
  // Request bereits rotiert → wir behandeln das wie Replay und revoken die Family.
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upd = (await (db.update(auth_refresh_tokens)
    .set({ rotated_at: now })
    .where(and(eq(auth_refresh_tokens.id, found.id), isNull(auth_refresh_tokens.rotated_at))) as any)) as { meta?: { changes?: number; rows_written?: number } } | undefined;
  const changed = upd?.meta?.changes ?? upd?.meta?.rows_written;
  if (typeof changed === "number" && changed === 0) {
    // Concurrent rotate verloren → Family revoken (Replay-Equivalent)
    await db.update(auth_refresh_tokens)
      .set({ revoked_at: now, revoke_reason: "concurrent_rotate" })
      .where(and(eq(auth_refresh_tokens.family_id, found.family_id), isNull(auth_refresh_tokens.revoked_at)));
    throw new CodedError("GH-AUTH-007");
  }

  const issued = await issueRefresh(db, {
    tenant_id: found.tenant_id,
    customer_id: found.customer_id,
    scope: found.scope.split(" ").filter(Boolean),
    client_id: found.client_id ?? undefined,
    parent_id: found.id,
    family_id: found.family_id,
  });

  return {
    new_refresh: issued,
    customer_id: found.customer_id,
    tenant_id: found.tenant_id,
    scope: found.scope.split(" ").filter(Boolean),
  };
}

export async function revokeRefresh(db: DB, plain: string): Promise<void> {
  const token_hash = await sha256Hex(plain);
  await db.update(auth_refresh_tokens).set({ revoked_at: new Date().toISOString(), revoke_reason: "client_revoke" }).where(and(eq(auth_refresh_tokens.token_hash, token_hash), isNull(auth_refresh_tokens.revoked_at)));
}
