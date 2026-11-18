#!/usr/bin/env node
// Öffentliches Repo: jede Adresse in der Historie ist dauerhaft lesbar.
// Erlaubt sind nur noreply-Adressen, für Autor, Committer und Co-authored-by.
//
//   node scripts/check-commit-identity.mjs <von>..<bis>   (PR: base..head)
//   node scripts/check-commit-identity.mjs <sha>          (ein Commit, z. B. auf main)
import { execFileSync } from "node:child_process";

const ERLAUBT = [
  /@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
  /^noreply@anthropic\.com$/i,
];

const bereich = process.argv[2];
if (!bereich) {
  console.error("Aufruf: check-commit-identity.mjs <von>..<bis> | <sha>");
  process.exit(2);
}
const args = bereich.includes("..") ? [bereich] : ["-1", bereich];
const SEP = "\u001f";
const out = execFileSync("git", ["log", "--format=%H" + SEP + "%ae" + SEP + "%ce" + SEP + "%B%x1e", ...args], { encoding: "utf8" });

const funde = [];
for (const eintrag of out.split("\u001e").map((s) => s.trim()).filter(Boolean)) {
  const [sha, autor, committer, text] = eintrag.split(SEP);
  const adressen = [["Autor", autor], ["Committer", committer]];
  for (const m of (text ?? "").matchAll(/^co-authored-by:.*<([^>]+)>\s*$/gim)) adressen.push(["Co-authored-by", m[1]]);
  for (const [rolle, adresse] of adressen) {
    if (!ERLAUBT.some((re) => re.test(adresse))) funde.push(`${sha.slice(0, 7)} ${rolle}: keine noreply-Adresse`);
  }
}

if (funde.length) {
  console.error(funde.join("\n"));
  console.error("\nDas Repo ist öffentlich. Bitte mit der GitHub-noreply-Adresse committen:");
  console.error("  git config user.email <id>+<login>@users.noreply.github.com");
  console.error("und die Änderung auf einem neuen Branch neu committen (die alten Commits bleiben über refs/pull/<nr>/head sichtbar).");
  process.exit(1);
}
console.log("Commit-Identität OK: nur noreply-Adressen.");
