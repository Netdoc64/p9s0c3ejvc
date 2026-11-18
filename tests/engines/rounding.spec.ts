import { describe, expect, it } from "vitest";
import { roundHalfToEvenInt } from "../../src/engines/pricing";

describe("roundHalfToEvenInt (#M-001 banker's rounding integer-scaled)", () => {
  it("rounds down when below half", () => {
    expect(roundHalfToEvenInt(149, 100)).toBe(1); // 1.49 → 1
  });

  it("rounds up when above half", () => {
    expect(roundHalfToEvenInt(151, 100)).toBe(2); // 1.51 → 2
  });

  it("rounds to even on exact half (down)", () => {
    expect(roundHalfToEvenInt(150, 100)).toBe(2); // 1.50 → 2 (even)
  });

  it("rounds to even on exact half (up to even)", () => {
    expect(roundHalfToEvenInt(250, 100)).toBe(2); // 2.50 → 2 (even)
    expect(roundHalfToEvenInt(350, 100)).toBe(4); // 3.50 → 4 (even)
  });

  it("handles zero", () => {
    expect(roundHalfToEvenInt(0, 100)).toBe(0);
  });

  it("handles negative", () => {
    expect(roundHalfToEvenInt(-150, 100)).toBe(-2); // -1.50 → -2
    expect(roundHalfToEvenInt(-149, 100)).toBe(-1);
  });

  it("integer-scaled pricing example: 12.5% off 1000 cents", () => {
    // 1000 * (10000 - 1250) / 10000 = 1000 * 8750 / 10000 = 8750000/10000 = 875
    expect(roundHalfToEvenInt(1000 * (10000 - 1250), 10000)).toBe(875);
  });

  it("avoids float-drift regression (0.1+0.2 case)", () => {
    // Float arithmetic for 1199 * 0.857 might drift; integer-skaliert ist stabil.
    // 1199 * (10000 - 1430) = 1199 * 8570 = 10275430; /10000 = 1027.543 → 1028 (round up).
    expect(roundHalfToEvenInt(1199 * (10000 - 1430), 10000)).toBe(1028);
  });
});
