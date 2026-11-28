const messages = new Map([
  ["GH-TENANT-001", "Dieser Betrieb ist nicht eingerichtet. Bitte frage deinen Großhändler."],
  ["GH-AUTH-002", "Bitte melde dich erneut an."],
  ["GH-AUTH-005", "Bitte melde dich erneut an."],
  ["GH-AUTH-006", "Der Code ist falsch oder abgelaufen. Bitte fordere einen neuen an."],
  ["GH-AUTH-007", "Bitte melde dich erneut an."],
  ["GH-EXT-003", "Die Anmeldung per E-Mail ist gerade nicht möglich. Bitte versuche es später erneut."],
  ["GH-CLIENT-001", "Du brauchst eine neuere Version der App."],
  ["GH-ORDER-001", "Bestellung nicht verfügbar."],
  ["GH-PROD-001", "Ein Artikel ist nicht mehr verfügbar. Prüfe deinen Warenkorb."],
  ["GH-PROD-003", "Eine Position unterschreitet die Mindestmenge."],
  ["GH-PRICE-001", "Für diese Position liegt kein aktueller Preis vor."],
  ["GH-INPUT-001", "Prüfe die ausgewählten Mengen und Artikel."],
]);

const generalMessage = "Der Bestellservice konnte die Anfrage nicht abschließen.";

export async function describeRequestFailure(response?: Response) {
  if (!response) return { message: "Keine Verbindung zum Bestellservice.", code: "NETWORK" };

  const retryAfter = response.headers.get("Retry-After") ?? "";
  if (response.status === 429) {
    const seconds = /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
    const minutes = Math.ceil(wait / 60);
    const delay = minutes === 1 ? "einer Minute" : `${minutes} Minuten`;
    return { message: `Zu viele Versuche. Bitte versuche es in ${delay} erneut.`, code: "RATE", retryAfter: wait };
  }

  const problem: { code?: unknown; instance?: unknown } | null = await response.json().catch(() => null);
  const code = typeof problem?.code === "string" ? problem.code : `HTTP-${response.status}`;
  const reference = typeof problem?.instance === "string" && /^[a-z0-9_-]{1,128}$/i.test(problem.instance)
    ? ` Vorgangsnummer: ${problem.instance}.`
    : "";
  const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
  return { message: messages.get(code) ?? generalMessage + reference, code,
    retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined };
}
