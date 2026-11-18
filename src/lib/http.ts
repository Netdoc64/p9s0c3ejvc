/**
 * HTTP-Layer-Helper: zentrale Limit/Cursor-Parser, Body-Parse mit RFC-7807-Fehler.
 * Audit-Fixes #V-005, #V-013, #T-008 (signed cursor).
 */
import type { Context } from "hono";
import { CodedError } from "../errors/catalog";
import { signCursor as signCursorImpl, verifyCursor } from "./cursor";
import type { Env } from "../env";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseLimit(raw: string | undefined, opts?: { max?: number; default?: number }): number {
  const max = opts?.max ?? MAX_LIMIT;
  const def = opts?.default ?? DEFAULT_LIMIT;
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(n, 1), max);
}

export interface CursorJSON {
  created_at: string;
  id: string;
}

/**
 * Signed-Cursor-Verify (#T-008). Wirft GH-INPUT-001 bei Tampering oder Format-Fehler.
 */
export async function parseCursor(env: Env, raw: string | undefined): Promise<CursorJSON | undefined> {
  if (!raw) return undefined;
  const decoded = await verifyCursor<Partial<CursorJSON>>(env, raw);
  if (typeof decoded.created_at !== "string" || typeof decoded.id !== "string") {
    throw new CodedError("GH-INPUT-001", { field: "cursor" });
  }
  return { created_at: decoded.created_at, id: decoded.id };
}

export async function signCursor(env: Env, payload: CursorJSON): Promise<string> {
  return signCursorImpl(env, payload as unknown as Record<string, unknown>);
}

/**
 * Body-Parser mit RFC-7807-konformer Fehlerantwort. Wirft GH-INPUT-001 bei Parse-Fail.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody(c: Context<any>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new CodedError("GH-INPUT-001", { reason: "invalid JSON body" });
  }
}
