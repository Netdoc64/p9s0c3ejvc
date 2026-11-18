import { describe, expect, it } from "vitest";
import { compareSemver, isVersionAtLeast, parseSemver } from "../src/services/version-cmp";

describe("semver", () => {
  it("parses major.minor.patch", () => {
    expect(parseSemver("1.4.10")).toEqual({ major: 1, minor: 4, patch: 10, pre: null });
    expect(parseSemver("2.0.0-beta1")).toEqual({ major: 2, minor: 0, patch: 0, pre: "beta1" });
    expect(parseSemver("not-a-version")).toBeNull();
  });

  it("compares correctly", () => {
    expect(compareSemver("1.4.2", "1.4.10")).toBe(-1);
    expect(compareSemver("1.5.0", "1.4.10")).toBe(1);
    expect(compareSemver("1.4.10", "1.4.10")).toBe(0);
    expect(compareSemver("2.0.0-beta1", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0-beta2", "2.0.0-beta1")).toBe(1);
  });

  it("isVersionAtLeast", () => {
    expect(isVersionAtLeast("1.5.0", "1.4.0")).toBe(true);
    expect(isVersionAtLeast("1.4.0", "1.4.0")).toBe(true);
    expect(isVersionAtLeast("1.3.0", "1.4.0")).toBe(false);
  });
});
