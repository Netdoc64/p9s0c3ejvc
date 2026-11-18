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

/** GitHub-Konten, unter denen Codex arbeitet. Ihre PRs sind immer Frontend, egal wie der Branch heißt. */
export const CODEX_KONTEN = ["fsvarrunner"];

/**
 * Seite einer PR: zuerst nach dem Konto, das sie öffnet, dann nach dem Branch.
 * Das Konto geht vor, weil ein Branch-Name frei wählbar ist (am 18.11. öffnete
 * Codex eine Backend-PR von `orchester/…`).
 */
export function seiteVonPr(branch, autor) {
  if (autor && CODEX_KONTEN.includes(String(autor).toLowerCase())) return "frontend";
  return seiteVonBranch(branch);
}

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
