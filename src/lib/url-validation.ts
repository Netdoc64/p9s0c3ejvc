/**
 * SSRF-Schutz für User-bereitgestellte URLs (Webhook-Subscriptions etc.).
 * Audit-Fix #T-005 / #V-007.
 *
 * Strategie:
 *  - Nur https:// erlauben.
 *  - Hostname als IP-Literal: blockt private/loopback/link-local/CGNAT/Multicast.
 *  - Hostname als DNS-Name: blockt `localhost`, `*.local`, `*.internal`, `*.lan`,
 *    `*.localhost`, leere Labels.
 *  - Keine DNS-Resolution (CF-Worker hat fetch-egress, keine zuverlässige Resolver-API).
 *    Dadurch bleibt eine Lücke gegen DNS-rebinding/Public-DNS-zu-Privater-IP — das ist
 *    in v1 akzeptiert; CF-Edge kappt einige interne Bereiche. Future: IP-Bind in Pre-Flight.
 */

const PRIVATE_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.intra$/i,
  /\.test$/i,
  /\.example$/i,
  /\.invalid$/i,
];

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map((n) => Number(n));
  if ([a, b, c, d].some((n) => n === undefined || n < 0 || n > 255)) return true; // malformed → treat as private/invalid
  // 10/8
  if (a === 10) return true;
  // 172.16/12
  if (a === 172 && (b as number) >= 16 && (b as number) <= 31) return true;
  // 192.168/16
  if (a === 192 && b === 168) return true;
  // 127/8
  if (a === 127) return true;
  // 169.254/16 (link-local + AWS metadata)
  if (a === 169 && b === 254) return true;
  // 100.64/10 (CGNAT)
  if (a === 100 && (b as number) >= 64 && (b as number) <= 127) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 224/4 multicast
  if ((a as number) >= 224 && (a as number) <= 239) return true;
  // 240/4 reserved
  if ((a as number) >= 240) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  // strip brackets if present
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!h.includes(":")) return false;
  // ::1 loopback
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // :: unspecified
  if (h === "::") return true;
  // fc00::/7 unique local
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  // fe80::/10 link-local
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  // ff00::/8 multicast
  if (h.startsWith("ff")) return true;
  // ::ffff: IPv4-mapped → re-check IPv4
  const v4Mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Mapped && v4Mapped[1]) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

export interface UrlValidationError {
  ok: false;
  reason: string;
}
export interface UrlValidationOk {
  ok: true;
}
export type UrlValidationResult = UrlValidationOk | UrlValidationError;

export function validatePublicHttpsUrl(raw: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "https_required" };
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "empty_host" };
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) return { ok: false, reason: "private_hostname_blocked" };
  if (host.includes("..")) return { ok: false, reason: "malformed_host" };
  if (isPrivateIPv4(host)) return { ok: false, reason: "private_ipv4_blocked" };
  if (isPrivateIPv6(host)) return { ok: false, reason: "private_ipv6_blocked" };
  // userinfo (https://user:pass@host) verbieten — kann Server-Logs verseuchen
  if (url.username || url.password) return { ok: false, reason: "userinfo_not_allowed" };
  return { ok: true };
}
