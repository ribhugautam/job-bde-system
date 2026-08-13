import { describe, it, expect } from "vitest";
import {
  MAX_FOLLOW_UPS,
  followUpStep,
  nextFollowUpDue,
} from "@/lib/pipeline/followup-schedule";

const CONFIG = {
  ENABLE_FOLLOWUPS: true,
  FOLLOWUP_FIRST_DAYS: 4,
  FOLLOWUP_FINAL_DAYS: 10,
};

const SENT = new Date("2026-08-01T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("nextFollowUpDue", () => {
  it("schedules the first nudge at FOLLOWUP_FIRST_DAYS after the original send", () => {
    const due = nextFollowUpDue(0, SENT, CONFIG);
    expect(due).toEqual(new Date(SENT.getTime() + 4 * DAY));
  });

  it("measures the final message from the ORIGINAL send, not the first nudge", () => {
    // This is the whole reason offsets are absolute. Chaining off the previous
    // follow-up lets delivery delays compound, so a configured "day 10" could
    // land on day 14 and the setting would stop meaning what it says.
    const due = nextFollowUpDue(1, SENT, CONFIG);
    expect(due).toEqual(new Date(SENT.getTime() + 10 * DAY));
  });

  it("ends the sequence permanently after the final message", () => {
    expect(nextFollowUpDue(2, SENT, CONFIG)).toBeNull();
    expect(nextFollowUpDue(3, SENT, CONFIG)).toBeNull();
    expect(nextFollowUpDue(99, SENT, CONFIG)).toBeNull();
  });

  it("never schedules more than MAX_FOLLOW_UPS messages", () => {
    const scheduled = [0, 1, 2, 3, 4].filter(
      (count) => nextFollowUpDue(count, SENT, CONFIG) !== null
    );
    expect(scheduled).toHaveLength(MAX_FOLLOW_UPS);
  });

  it("schedules nothing at all when follow-ups are disabled", () => {
    const off = { ...CONFIG, ENABLE_FOLLOWUPS: false };
    expect(nextFollowUpDue(0, SENT, off)).toBeNull();
    expect(nextFollowUpDue(1, SENT, off)).toBeNull();
  });

  it("respects custom offsets", () => {
    const custom = {
      ENABLE_FOLLOWUPS: true,
      FOLLOWUP_FIRST_DAYS: 2,
      FOLLOWUP_FINAL_DAYS: 30,
    };
    expect(nextFollowUpDue(0, SENT, custom)).toEqual(
      new Date(SENT.getTime() + 2 * DAY)
    );
    expect(nextFollowUpDue(1, SENT, custom)).toEqual(
      new Date(SENT.getTime() + 30 * DAY)
    );
  });

  it("keeps the second message strictly after the first", () => {
    const first = nextFollowUpDue(0, SENT, CONFIG)!;
    const second = nextFollowUpDue(1, SENT, CONFIG)!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("does not mutate the date it was given", () => {
    const original = new Date(SENT.getTime());
    nextFollowUpDue(0, original, CONFIG);
    expect(original).toEqual(SENT);
  });

  it("handles a send that crosses a month boundary", () => {
    const lateAugust = new Date("2026-08-30T09:00:00Z");
    expect(nextFollowUpDue(0, lateAugust, CONFIG)).toEqual(
      new Date("2026-09-03T09:00:00Z")
    );
  });
});

describe("followUpStep", () => {
  it("maps send count to the message being written", () => {
    expect(followUpStep(0)).toBe(1); // nothing sent yet -> first nudge
    expect(followUpStep(1)).toBe(2); // one sent -> final message
  });
});
