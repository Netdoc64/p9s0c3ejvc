import { and, eq, gt, isNull, sql as sqlOp } from "drizzle-orm";
import type { DB } from "../db/client";
import { auth_magic_link_tokens } from "../db/schema/auth";
import { customers } from "../db/schema/customers";
import { CodedError } from "../errors/catalog";
import { newId } from "../lib/ids";
import { sha256Hex } from "../lib/crypto";

const TTL_SEC = 600;
const MAX_ATTEMPTS = 5;

/**
 * Magic-Link-Code: 8-stellig Crockford-Base32 ohne ambiguäre Zeichen (0/O, 1/I).
 * Entropie: 8 × log2(32) = 40 Bit (vs. 6-Digit-Decimal ≈ 20 Bit).
 *
 * Bei Rate-Limit 3/min ist Brute-Force eines 8-Char-Code-Bereichs
 * (32^8 = ~1 Trillion Möglichkeiten) praktisch unmöglich.
 * Der alte Funktionsname `generate6DigitCode` wird beibehalten für
 * API-Kompatibilität — gibt jetzt 8-Char-Base32 zurück.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 Zeichen
const CODE_LENGTH = 8;

export function generate6DigitCode(): string {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[(buf[i] as number) % 32];
  }
  return out;
}

export interface RequestResult {
  customer_id: string | null;
  code?: string; // nur intern, niemals an Caller
  ttl_sec: number;
}

/**
 * Generiert einen Magic-Link-Code, der per Email versendet wird.
 * Findet Customer per (tenant_id, email). Wenn nicht gefunden, gibt success-shape
 * trotzdem zurück (User-Enumeration-Schutz).
 * Stellt sicher, dass nur 1 aktiver Code pro Customer existiert (vorherige werden invalidiert).
 */
export async function createMagicLink(db: DB, tenant_id: string, email: string): Promise<RequestResult> {
  const cs = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenant_id, tenant_id), eq(customers.email, email), isNull(customers.deleted_at)))
    .limit(1);
  const customer = cs[0];
  if (!customer) {
    // User-Enumeration-Schutz (#A-010): bei nicht-existentem Customer
    // dieselbe Crypto-Arbeit ausführen wie im happy path, damit die Latenz
    // identisch ist. Wir generieren einen Throwaway-Hash gegen einen
    // Dummy-Customer-ID und schlafen kurz, schreiben aber NICHT in die DB.
    const dummyCode = generate6DigitCode();
    await sha256Hex(`${tenant_id}:dummy:${dummyCode}`);
    await new Promise((r) => setTimeout(r, 5));
    return { customer_id: null, ttl_sec: TTL_SEC };
  }

  // Vorherige aktive Codes invalidieren
  await db
    .update(auth_magic_link_tokens)
    .set({ consumed_at: new Date().toISOString() })
    .where(and(eq(auth_magic_link_tokens.customer_id, customer.id), isNull(auth_magic_link_tokens.consumed_at)));

  const code = generate6DigitCode();
  const code_hash = await sha256Hex(`${tenant_id}:${customer.id}:${code}`);
  const now = new Date();
  await db.insert(auth_magic_link_tokens).values({
    id: newId("event"),
    tenant_id,
    customer_id: customer.id,
    email,
    code_hash,
    expires_at: new Date(now.getTime() + TTL_SEC * 1000).toISOString(),
    created_at: now.toISOString(),
  });
  return { customer_id: customer.id, code, ttl_sec: TTL_SEC };
}

export interface VerifyResult {
  customer_id: string;
  scope: string[];
}

export async function verifyMagicLink(db: DB, tenant_id: string, email: string, code: string): Promise<VerifyResult> {
  const cs = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenant_id, tenant_id), eq(customers.email, email), isNull(customers.deleted_at)))
    .limit(1);
  const customer = cs[0];
  if (!customer) throw new CodedError("GH-AUTH-006");

  const code_hash = await sha256Hex(`${tenant_id}:${customer.id}:${code}`);
  const now = new Date().toISOString();
  const tokens = await db
    .select()
    .from(auth_magic_link_tokens)
    .where(and(
      eq(auth_magic_link_tokens.customer_id, customer.id),
      eq(auth_magic_link_tokens.code_hash, code_hash),
      isNull(auth_magic_link_tokens.consumed_at),
      gt(auth_magic_link_tokens.expires_at, now),
    ))
    .limit(1);
  const token = tokens[0];
  if (!token) {
    // Bumpe attempts auf den jüngsten aktiven Token-Datensatz (Brute-Force-Erkennung)
    await db
      .update(auth_magic_link_tokens)
      .set({ attempts: sqlOp`attempts + 1` })
      .where(and(eq(auth_magic_link_tokens.customer_id, customer.id), isNull(auth_magic_link_tokens.consumed_at)));
    throw new CodedError("GH-AUTH-006");
  }
  if (token.attempts >= MAX_ATTEMPTS) throw new CodedError("GH-AUTH-006");

  await db.update(auth_magic_link_tokens).set({ consumed_at: now }).where(eq(auth_magic_link_tokens.id, token.id));

  return { customer_id: customer.id, scope: ["customer_self"] };
}
