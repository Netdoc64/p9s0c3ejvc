/**
 * Zugangsdaten der Module verschlüsseln.
 *
 * Hauptschlüssel ist das Worker-Secret `MODULE_KEK` (64 Hex-Zeichen, gewürfelt
 * und verteilt vom Business Manager). Je Datensatz wird mit HKDF-SHA256 und
 * einem zufälligen Salz ein eigener AES-256-GCM-Schlüssel abgeleitet; Tenant
 * und Modul gehen als `info` UND als Zusatzdaten (AAD) ein. Ein kopierter
 * Datensatz lässt sich deshalb weder bei einem anderen Tenant noch bei einem
 * anderen Modul entschlüsseln.
 *
 * Kein Klartext verlässt dieses Modul außer an den Aufrufer, der ihn für den
 * Lieferanten-Aufruf braucht. Nichts hier loggt.
 */
import type { Env } from "../env";
import { CodedError } from "../errors/catalog";
import { sha256Hex } from "../lib/crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function kekBytes(env: Env): Uint8Array {
  const hex = env.MODULE_KEK;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new CodedError("GH-MODULE-002");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function kekConfigured(env: Env): boolean {
  return Boolean(env.MODULE_KEK && /^[0-9a-f]{64}$/i.test(env.MODULE_KEK));
}

async function recordKey(env: Env, salt: Uint8Array, context: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", kekBytes(env), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(context) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Sealed { salt: string; iv: string; ciphertext: string; fingerprint: string }

export async function seal(env: Env, tenantId: string, moduleId: string, secrets: Record<string, string>): Promise<Sealed> {
  const context = `module:${tenantId}:${moduleId}`;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await recordKey(env, salt, context);
  const plain = JSON.stringify(Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, key, enc.encode(plain)));
  // Abdruck wie im Business Manager: 12 Hex-Zeichen, gebunden an Tenant und Modul.
  const fingerprint = (await sha256Hex(`${context}:${plain}`)).slice(0, 12);
  return { salt: b64(salt), iv: b64(iv), ciphertext: b64(ct), fingerprint };
}

export async function unseal(env: Env, tenantId: string, moduleId: string, s: { salt: string; iv: string; ciphertext: string }): Promise<Record<string, string>> {
  const context = `module:${tenantId}:${moduleId}`;
  try {
    const key = await recordKey(env, unb64(s.salt), context);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: enc.encode(context) }, key, unb64(s.ciphertext));
    return JSON.parse(dec.decode(plain)) as Record<string, string>;
  } catch (err) {
    if (err instanceof CodedError) throw err;
    throw new CodedError("GH-MODULE-003");
  }
}
