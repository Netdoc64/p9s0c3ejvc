import { hmacSha256Hex, sha256Hex } from "../../src/lib/crypto";

export interface SignOptions {
  apiKey: string;
  hmacSecret: string;
  method: string;
  /** Full request path inkl. Query-String. Pathname + Search fliessen in die Signatur (#A-002). */
  pathname: string;
  body?: string | Uint8Array;
  timestamp?: number;
  idempotencyKey?: string;
  extraHeaders?: Record<string, string>;
}

export async function signedHeaders(opts: SignOptions): Promise<Record<string, string>> {
  const ts = (opts.timestamp ?? Math.floor(Date.now() / 1000)).toString();
  const url = new URL(opts.pathname, "https://example.com");
  const body = opts.body ?? "";
  const bodyHash = typeof body === "string" ? await sha256Hex(body) : await sha256Hex(body);
  const signingString = `${opts.method}\n${url.pathname}${url.search}\n${ts}\n${bodyHash}`;
  const signature = await hmacSha256Hex(opts.hmacSecret, signingString);
  const headers: Record<string, string> = {
    "X-Api-Key": opts.apiKey,
    "X-Signature": signature,
    "X-Timestamp": ts,
    ...(opts.idempotencyKey ? { "X-Idempotency-Key": opts.idempotencyKey } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  if (typeof body === "string" && body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return headers;
}
