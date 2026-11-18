import { describe, expect, it } from "vitest";

declare global {
  // Vite-Typen sind im Projekt nicht eingebunden -> schmale lokale Signatur.
  interface ImportMeta { glob(pattern: string, opts: object): unknown }
}

// Workers-Pool (kein fs): Dateiliste per Vite-Glob. Bewusst "*" statt "*.sql",
// damit auch falsch benannte Dateien auffallen.
const files = import.meta.glob("/migrations/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const names = Object.keys(files).map((p) => p.slice(p.lastIndexOf("/") + 1)).sort();

const HINT = "naechste freie Nummer = max+1";
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/** Prueft eine Dateiliste; liefert Fehlermeldungen (leer = ok). */
export function pruefeNummern(list: string[]): string[] {
  const errors: string[] = [];
  const bad = list.filter((n) => !NAME.test(n));
  if (bad.length) errors.push(`Name entspricht nicht ^\d{4}_[a-z0-9_]+\.sql$: ${bad.join(", ")}`);
  const byNum = new Map<number, string[]>();
  for (const n of list.filter((x) => NAME.test(x))) {
    const num = Number(n.slice(0, 4));
    byNum.set(num, [...(byNum.get(num) ?? []), n]);
  }
  for (const [num, ns] of byNum) {
    if (ns.length > 1) errors.push(`doppelte Nummer ${String(num).padStart(4, "0")}: ${ns.join(", ")} (${HINT})`);
  }
  const max = Math.max(0, ...byNum.keys());
  for (let i = 1; i <= max; i++) {
    if (!byNum.has(i)) errors.push(`fehlende Nummer ${String(i).padStart(4, "0")} (${HINT})`);
  }
  return errors;
}

describe("migrations/ Nummerierung", () => {
  it("liest Migrationen ein", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("eindeutige, lueckenlose vierstellige Praefixe ab 0001", () => {
    expect(pruefeNummern(names), pruefeNummern(names).join("\n")).toEqual([]);
  });

  it("erkennt Doppelte, Luecken und falsche Namen (Selbsttest)", () => {
    expect(pruefeNummern(["0001_a.sql", "0002_b.sql"])).toEqual([]);
    expect(pruefeNummern(["0001_a.sql", "0001_b.sql"]).join()).toContain("doppelte Nummer 0001");
    expect(pruefeNummern(["0001_a.sql", "0003_c.sql"]).join()).toContain("fehlende Nummer 0002");
    expect(pruefeNummern(["0001_a.sql", "02_b.sql"]).join()).toContain("Name entspricht nicht");
    expect(pruefeNummern(["0002_a.sql"]).join()).toContain("max+1");
  });
});
