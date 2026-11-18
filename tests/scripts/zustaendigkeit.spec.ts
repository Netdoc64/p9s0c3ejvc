import { describe, expect, it } from "vitest";
// @ts-expect-error — reines ESM-Skript ohne Typen
import { fremdePfade, istFrontend, seiteVonBranch } from "../../scripts/zustaendigkeit.mjs";

describe("Zuständigkeit Claude/Codex (AGENTS.md)", () => {
  it("ordnet Branches einer Seite zu", () => {
    expect(seiteVonBranch("codex/mobile-split")).toBe("frontend");
    expect(seiteVonBranch("orchester/ziel-thema")).toBe("backend");
    expect(seiteVonBranch("claude/fix")).toBe("backend");
    expect(seiteVonBranch("feature/hand")).toBeNull();
  });

  it("kennt die Frontend-Pfade", () => {
    for (const p of ["mobile/app/index.tsx", "docs/frontend-plan.md", "docs/frontend-build-plan.json", "scripts/check-frontend-plan.mjs", ".github/workflows/mobile.yml"]) {
      expect(istFrontend(p), p).toBe(true);
    }
    for (const p of ["src/routes/customer-api.ts", "src/openapi/spec.ts", "migrations/0026_x.sql", ".github/workflows/ci.yml", "tests/routes/customer-pilot.spec.ts", "docs/runbooks/disaster-restore.md"]) {
      expect(istFrontend(p), p).toBe(false);
    }
  });

  it("meldet fremde Pfade je Seite", () => {
    const pfade = ["mobile/app/index.tsx", "src/openapi/spec.ts"];
    expect(fremdePfade("frontend", pfade)).toEqual(["src/openapi/spec.ts"]);
    expect(fremdePfade("backend", pfade)).toEqual(["mobile/app/index.tsx"]);
    expect(fremdePfade(null, pfade)).toEqual([]);
  });
});
