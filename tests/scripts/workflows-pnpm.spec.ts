import { describe, expect, it } from "vitest";

/**
 * `package.json` pinnt pnpm über `packageManager`. Nennt ein Workflow
 * zusätzlich `version:` an `pnpm/action-setup`, bricht die Action mit
 * „Multiple versions of pnpm specified“ ab — und das fällt erst auf, wenn der
 * Workflow läuft. Bei den Deploy-Workflows ist das der Moment, in dem man
 * ausrollen will.
 */
const workflows = import.meta.glob("/.github/workflows/*.yml", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const pkg = import.meta.glob("/package.json", { import: "default", eager: true }) as Record<string, { packageManager?: string }>;

describe("pnpm-Version in Workflows", () => {
  it("package.json pinnt pnpm", () => {
    expect(Object.values(pkg)[0]?.packageManager).toMatch(/^pnpm@\d/);
  });

  it("die Workflows werden gefunden", () => {
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
  });

  for (const [pfad, text] of Object.entries(workflows)) {
    it(`${pfad}: pnpm/action-setup ohne eigene version`, () => {
      const zeilen = text.split("\n");
      zeilen.forEach((zeile, i) => {
        if (!zeile.includes("pnpm/action-setup@")) return;
        const einzug = zeile.search(/\S/);
        for (let j = i + 1; j < zeilen.length; j++) {
          const z = zeilen[j]!;
          if (z.trim() === "") continue;
          if (z.search(/\S/) <= einzug) break;
          expect(z, `${pfad}:${j + 1}`).not.toMatch(/^\s+version:/);
        }
      });
    });
  }
});
