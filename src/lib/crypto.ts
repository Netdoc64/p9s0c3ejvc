/**
 * Edge-/Workers-kompatible Crypto-Helpers.
 * Alles via WebCrypto, keine Node-Module.
 */

const encoder = new TextEncoder();

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(buf);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bufferToHex(sig);
}

export async function hmacSha256Verify(secret: string, message: string, expectedHex: string): Promise<boolean> {
  const computed = await hmacSha256Hex(secret, message);
  return constantTimeEqualHex(computed, expectedHex);
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (value === undefined) continue;
    hex += value.toString(16).padStart(2, "0");
  }
  return hex;
}

export function randomSecret(byteLength = 32): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
