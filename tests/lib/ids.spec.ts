import { describe, expect, it } from "vitest";
import { ID_PREFIXES, isIdOf, newId, parseIdKind } from "../../src/lib/ids";

describe("ids", () => {
  it("each kind produces a value with the right prefix", () => {
    for (const kind of Object.keys(ID_PREFIXES) as Array<keyof typeof ID_PREFIXES>) {
      const id = newId(kind);
      expect(id.startsWith(ID_PREFIXES[kind])).toBe(true);
      expect(isIdOf(id, kind)).toBe(true);
      expect(parseIdKind(id)).toBe(kind);
    }
  });

  it("10k generations are collision-free for ord_", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newId("order"));
    expect(seen.size).toBe(10_000);
  });

  it("ord_ ids are roughly time-sortable", () => {
    const a = newId("order");
    // tiny pause not strictly needed: ulid monotonic within ms
    const b = newId("order");
    expect([a, b].sort()[0]).toBe(a);
  });
});
