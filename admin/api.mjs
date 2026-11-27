import { config } from "./config.mjs";

/** @typedef {{id: string, email: string, role: "owner" | "staff"}} StaffProfile */
const sessionKey = "grosshandel-admin-session";
const apiUrl = config.apiUrl.replace(/\/$/, "");
export const live = Boolean(apiUrl);

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {Response} response */
async function responseError(response) {
  const body = await response.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "";
  if (response.status === 401) return new ApiError(401, code, "Die Sitzung ist abgelaufen. Bitte erneut anmelden.");
  if (response.status === 403) return new ApiError(403, code, "Deine Rolle hat hierfür keine Berechtigung.");
  if (response.status === 410) return new ApiError(410, code, "Der Code ist falsch oder abgelaufen. Fordere einen neuen an.");
  if (response.status === 429) {
    const raw = response.headers.get("Retry-After");
    const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw ?? "") - Date.now()) / 1000);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
    return new ApiError(429, code, `Zu viele Versuche. Warte ${wait} Sekunden und versuche es erneut.`);
  }
  const message = new Map([
    ["GH-INPUT-001", "Bitte prüfe deine Eingaben."],
    ["GH-TENANT-001", "Der Betrieb oder der Eintrag wurde nicht gefunden."],
    ["GH-EXT-003", "Anmeldung per E-Mail ist gerade nicht möglich. Bitte versuche es später erneut."],
  ]).get(code) ?? "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.";
  return new ApiError(response.status, code, message);
}

export function endSession() {
  sessionStorage.removeItem(sessionKey);
}

export function activeToken() {
  try {
    const session = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
    if (session && typeof session.token === "string" && session.expiresAt > Date.now()) return session.token;
  } catch {
    // Treat invalid browser state as an expired session.
  }
  endSession();
  return null;
}

/** @template T @param {string} path @param {{method?: string, body?: object, publicRequest?: boolean}} [options] @returns {Promise<T>} */
export async function api(path, { method = "GET", body, publicRequest = false } = {}) {
  if (!live) throw new Error("Für den Demo-Modus ist keine API eingerichtet.");
  const token = publicRequest ? null : activeToken();
  if (!publicRequest && !token) throw new ApiError(401, "", "Bitte melde dich an.");
  const headers = new Headers();
  if (publicRequest) headers.set("X-Tenant-Slug", config.tenant);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(apiUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "", "Keine Verbindung zum Bestellservice.");
  }
  if (!response.ok) {
    if (response.status === 401 && !publicRequest && token === activeToken()) endSession();
    throw await responseError(response);
  }
  if (response.status === 204) return /** @type {T} */ (/** @type {unknown} */ (undefined));
  return response.json();
}

/** @param {string} email */
export function requestCode(email) {
  return api("/v1/auth/staff/code/request", { method: "POST", publicRequest: true, body: { email } });
}

/** @param {string} email @param {string} code */
export async function signIn(email, code) {
  /** @type {{access_token: string, expires_in: number}} */
  const result = await api("/v1/auth/staff/code/verify", { method: "POST", publicRequest: true, body: { email, code } });
  sessionStorage.setItem(sessionKey, JSON.stringify({
    token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000,
  }));
}

/** @returns {Promise<StaffProfile>} */
export function getProfile() {
  return api("/v1/staff/me");
}
