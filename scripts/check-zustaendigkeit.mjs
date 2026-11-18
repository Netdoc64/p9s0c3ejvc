#!/usr/bin/env node
// CI: prüft, ob eine PR nur Pfade ihrer Seite ändert (siehe AGENTS.md).
//   node scripts/check-zustaendigkeit.mjs <branch> <basis-sha> <kopf-sha>
import { execFileSync } from "node:child_process";
import { fremdePfade, seiteVonBranch } from "./zustaendigkeit.mjs";

const [branch, basis, kopf] = process.argv.slice(2);
if (!branch || !basis || !kopf) {
  console.error("Aufruf: check-zustaendigkeit.mjs <branch> <basis-sha> <kopf-sha>");
  process.exit(2);
}
const seite = seiteVonBranch(branch);
if (!seite) {
  console.log(`Branch ${branch}: keiner Seite zugeordnet (Mensch), keine Pfadgrenze.`);
  process.exit(0);
}
const pfade = execFileSync("git", ["diff", "--name-only", `${basis}...${kopf}`], { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);
const fremd = fremdePfade(seite, pfade);
if (fremd.length) {
  console.error(`Branch ${branch} gehört zum ${seite === "frontend" ? "Frontend (Codex)" : "Backend (Claude)"} und ändert fremde Pfade:`);
  for (const p of fremd) console.error(`  ${p}`);
  console.error("\nZuständigkeiten: AGENTS.md. Was auf der anderen Seite nötig ist, bitte als Issue anlegen.");
  process.exit(1);
}
console.log(`Zuständigkeit OK: ${pfade.length} Datei(en), alle auf der Seite ${seite}.`);
