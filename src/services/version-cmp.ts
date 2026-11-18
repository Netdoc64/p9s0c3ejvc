/**
 * SemVer-Vergleich.
 * Akzeptiert "MAJOR.MINOR.PATCH" optional mit "-prerelease" Suffix.
 * Pre-Release < Release der gleichen Major.Minor.Patch (z.B. 2.0.0-beta1 < 2.0.0).
 */

export function parseSemver(s: string): { major: number; minor: number; patch: number; pre: string | null } | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  // Release > Pre-release.
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return va.pre < vb.pre ? -1 : va.pre > vb.pre ? 1 : 0;
}

export function isVersionAtLeast(actual: string, min: string): boolean {
  return compareSemver(actual, min) >= 0;
}
