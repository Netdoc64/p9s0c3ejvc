import type { Env } from "../env";
import type { VatStatus } from "../schemas/customer";

export interface ViesResult {
  vat_id: string;
  status: VatStatus;
  checked_at: string;
  cached: boolean;
  warning?: "vies_unavailable";
  raw_name?: string;
}

const TIMEOUT_MS = 5000;
const CACHE_TTL_SEC = 24 * 60 * 60;

export interface ViesClient {
  /**
   * Validiert eine VAT-ID, nutzt KV-Cache, fängt Timeouts/5xx ab und gibt `unknown`
   * mit Warning zurück. Wirft niemals.
   */
  validate(env: Env, vat_id: string, opts?: { skipCache?: boolean }): Promise<ViesResult>;
}

interface CachedEntry {
  status: VatStatus;
  checked_at: string;
  raw_name?: string;
}

function normalize(vat_id: string): { country: string; number: string } | null {
  // #P-006: strict format → keine Path-Traversal-Variants in der URL möglich.
  const cleaned = vat_id.replace(/[\s.\-]/g, "").toUpperCase();
  const m = cleaned.match(/^([A-Z]{2})([A-Z0-9]{2,15})$/);
  if (!m) return null;
  return { country: m[1] as string, number: m[2] as string };
}

async function fetchVies(country: string, number: string): Promise<{ valid: boolean; name?: string }> {
  // EU VIES REST-Proxy. URL-Encoding (#P-006) + Format ist bereits strict.
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${encodeURIComponent(country)}/vat/${encodeURIComponent(number)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`vies http ${res.status}`);
    const body = (await res.json()) as { valid?: boolean; name?: string; isValid?: boolean };
    const valid = body.valid ?? body.isValid ?? false;
    return { valid, name: body.name };
  } finally {
    clearTimeout(timer);
  }
}

export const realViesClient: ViesClient = {
  async validate(env, vat_id, opts) {
    const norm = normalize(vat_id);
    if (!norm) {
      return { vat_id, status: "invalid", checked_at: new Date().toISOString(), cached: false };
    }
    const cacheKey = `vies:${norm.country}${norm.number}`;
    if (!opts?.skipCache) {
      try {
        const cached = await env.KV.get<CachedEntry>(cacheKey, "json");
        if (cached) {
          return { vat_id, status: cached.status, checked_at: cached.checked_at, cached: true, raw_name: cached.raw_name };
        }
      } catch {
        // KV transient fail → kein cache, weiter
      }
    }
    const checked_at = new Date().toISOString();
    try {
      const result = await fetchVies(norm.country, norm.number);
      const status: VatStatus = result.valid ? "valid" : "invalid";
      const entry: CachedEntry = { status, checked_at, raw_name: result.name };
      try {
        await env.KV.put(cacheKey, JSON.stringify(entry), { expirationTtl: CACHE_TTL_SEC });
      } catch {
        /* fail-open */
      }
      return { vat_id, status, checked_at, cached: false, raw_name: result.name };
    } catch {
      return { vat_id, status: "unknown", checked_at, cached: false, warning: "vies_unavailable" };
    }
  },
};

/** Test/Override-Hook. Default ist `realViesClient`. */
let activeClient: ViesClient = realViesClient;

export function setViesClient(client: ViesClient): void {
  activeClient = client;
}

export function resetViesClient(): void {
  activeClient = realViesClient;
}

export function vies(): ViesClient {
  return activeClient;
}
