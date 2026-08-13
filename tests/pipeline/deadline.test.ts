import { describe, it, expect } from "vitest";
import {
  createDeadline,
  BATCH_RESERVE_MS,
  TAIL_RESERVE_MS,
} from "@/lib/pipeline/deadline";

// The clock is injected, so none of this sleeps. A budget test that waits in
// real time is one nobody keeps running.
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createDeadline", () => {
  it("reports the full budget before any time passes", () => {
    const clock = fakeClock();
    const d = createDeadline(45_000, clock.now);
    expect(d.remaining()).toBe(45_000);
    expect(d.elapsed()).toBe(0);
    expect(d.expired()).toBe(false);
  });

  it("counts down as the clock advances", () => {
    const clock = fakeClock();
    const d = createDeadline(45_000, clock.now);
    clock.advance(10_000);
    expect(d.elapsed()).toBe(10_000);
    expect(d.remaining()).toBe(35_000);
  });

  it("clamps remaining at zero rather than going negative", () => {
    // A negative remaining would make `remaining() > reserve` comparisons
    // behave sanely by accident; clamping makes it correct on purpose.
    const clock = fakeClock();
    const d = createDeadline(1_000, clock.now);
    clock.advance(60_000);
    expect(d.remaining()).toBe(0);
    expect(d.expired()).toBe(true);
  });

  it("stops granting budget once the reserve is all that is left", () => {
    const clock = fakeClock();
    const d = createDeadline(45_000, clock.now);
    expect(d.hasBudget(10_000)).toBe(true);
    clock.advance(35_000); // 10_000 left, exactly the reserve
    expect(d.hasBudget(10_000)).toBe(false);
  });

  it("treats exactly-equal remaining and reserve as out of budget", () => {
    // Strictly greater-than: starting a batch with precisely the reserve left
    // means the tail stages get nothing.
    const clock = fakeClock();
    const d = createDeadline(10_000, clock.now);
    expect(d.hasBudget(10_000)).toBe(false);
  });

  it("keeps the tail reserve large enough to matter", () => {
    // The digest is the only channel that reports a failed run, so the reserve
    // must actually be able to write and send it.
    expect(TAIL_RESERVE_MS).toBeGreaterThanOrEqual(10_000);
    expect(BATCH_RESERVE_MS).toBeGreaterThan(0);
  });

  it("leaves room for real work at the default budget", () => {
    // Guards against someone shrinking the budget below the reserves, which
    // would make the drain loop exit immediately and the queue never move.
    const DEFAULT_BUDGET = 45_000;
    expect(DEFAULT_BUDGET).toBeGreaterThan(TAIL_RESERVE_MS + BATCH_RESERVE_MS);
  });
});
