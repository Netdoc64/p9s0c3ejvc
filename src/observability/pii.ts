/**
 * PII-Redaction für strukturierte Logs.
 *
 * Strategie:
 *  - Field-Tagging via Zod-`.describe("pii")` ODER expliziter Felder-Liste (PII_KEY_PATTERNS).
 *  - Logger ruft `redactPii(payload)` vor Serialisierung.
 *  - Werte werden durch `sha256:<8-Hex-Prefix>` ersetzt — nachvollziehbar (Korrelation),
 *    nicht reversierbar.
 */

import { sha256Hex } from "../lib/crypto";

/**
 * Wildcard-Patterns für PII-Feldnamen. Greift case-insensitive.
 * Erweiterbar — Plan-Revision wenn neue Felder hinzukommen.
 */
export const PII_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^email$/i,
  /\.email$/i,
  /^phone$/i,
  /\.phone$/i,
  /^name$/i,
  /\.name$/i,
  /^address(\..*)?$/i,
  /\.address(\..*)?$/i,
  /^vat_id$/i,
  /^password$/i,
  /^token$/i,
  /^refresh_token$/i,
  /^iban$/i,
  /^bic$/i,
  /^ssn$/i,
  /^passport$/i,
  // #L-001: customer_id ist DSGVO-Pseudonym, im Log redacted.
  /^customer_id$/i,
];

export function isPiiKey(path: string): boolean {
  return PII_KEY_PATTERNS.some((re) => re.test(path));
}

export async function piiHashTag(value: unknown): Promise<string> {
  if (value === null || value === undefined) return "<null>";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  const hex = await sha256Hex(str);
  return `sha256:${hex.slice(0, 8)}`;
}

/**
 * Rekursiv durch Object/Array. Sobald ein Schlüssel als PII matched, wird der
 * **Value** durch das Hash-Tag ersetzt. Tiefere Strukturen darunter werden NICHT
 * weiter durchsucht (der ganze Subtree gilt als sensitiv).
 */
export async function redactPii<T>(input: T, pathPrefix = ""): Promise<T> {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (let i = 0; i < input.length; i++) {
      out.push(await redactPii(input[i], `${pathPrefix}[${i}]`));
    }
    return out as unknown as T;
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const path = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (isPiiKey(path) || isPiiKey(k)) {
      obj[k] = await piiHashTag(v);
    } else if (v && typeof v === "object") {
      obj[k] = await redactPii(v, path);
    } else {
      obj[k] = v;
    }
  }
  return obj as T;
}

/** Tag-Marker für ad-hoc PII-Strings, z.B. `pii("hannes@example.com")`. */
export function piiTagged<T extends string>(value: T): { __pii: true; value: T } {
  return { __pii: true, value };
}

export function isPiiTagged(v: unknown): v is { __pii: true; value: string } {
  return typeof v === "object" && v !== null && "__pii" in v && (v as { __pii: unknown }).__pii === true;
}
