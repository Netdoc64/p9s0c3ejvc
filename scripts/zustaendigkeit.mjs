// Wer darf was ändern? Eine Quelle für AGENTS.md, CLAUDE.md und die CI.
//
//   Frontend (Codex):  Pilot-App und Oberflächenplanung
//   Backend (Claude):  alles andere — Worker, Daten, Tests, Betrieb, CI-Hauptdatei
//
// Der Vertrag zwischen beiden (OpenAPI, /v1/customer) ist Backend: Codex
// wünscht Änderungen per Issue, Claude baut sie.

export const FRONTEND = [
  /^mobile\//,
  /^docs\/frontend-[^/]+$/,
  /^scripts\/check-frontend-plan\.mjs$/,
  /^\.github\/workflows\/mobile\.yml$/,
];

export const istFrontend = (pfad) => FRONTEND.some((re) => re.test(pfad));

/** Welche Seite ein Branch ist, oder null für Branches ohne Zuordnung (Mensch). */
export function seiteVonBranch(branch) {
  if (/^codex\//.test(branch)) return "frontend";
  if (/^(orchester|claude)\//.test(branch)) return "backend";
  return null;
}

/** Pfade, die ein Branch dieser Seite nicht ändern darf. */
export function fremdePfade(seite, pfade) {
  if (seite === "frontend") return pfade.filter((p) => !istFrontend(p));
  if (seite === "backend") return pfade.filter((p) => istFrontend(p));
  return [];
}
