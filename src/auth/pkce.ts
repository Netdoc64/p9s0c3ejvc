import { sha256Hex } from "../lib/crypto";

/**
 * PKCE: code_challenge = base64url(sha256(code_verifier)) für method=S256.
 * Verifier ist 43-128 Zeichen; Challenge ist URL-safe base64 ohne Padding.
 *
 * Per OAuth 2.1 / RFC 9700 ist S256 die einzig akzeptierte Methode für public Clients.
 * Der "plain"-Pfad wurde absichtlich entfernt (Security-Audit #A-001).
 */
export async function verifyPkce(verifier: string, challenge: string, method: "S256"): Promise<boolean> {
  if (method !== "S256") return false;
  const hex = await sha256Hex(verifier);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const b64u = bytesToBase64Url(bytes);
  return constantTimeEqual(b64u, challenge);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
