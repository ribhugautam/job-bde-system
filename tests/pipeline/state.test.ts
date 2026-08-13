import { describe, it, expect } from "vitest";
import {
  JOB_STAGES,
  LEAD_STAGES,
  JOB_STATUSES,
  LEAD_STATUSES,
  MAX_ATTEMPTS,
  hasAttemptsLeft,
  isJobTerminal,
  isLeadTerminal,
  nextAttemptAt,
  nextAttemptDelayMs,
  nextJobStage,
  nextLeadStage,
} from "@/lib/pipeline/state";

describe("stage progression", () => {
  it("walks a job from enrich to done without skipping a stage", () => {
    const walked: string[] = ["enrich"];
    let stage = nextJobStage("enrich");
    // Bounded so a cycle in the table fails the test instead of hanging it.
    for (let i = 0; i < 10 && stage !== "done"; i++) {
      walked.push(stage);
      stage = nextJobStage(stage);
    }
    expect(walked).toEqual(["enrich", "score", "draft", "dispatch"]);
    expect(stage).toBe("done");
  });

  it("skips enrich for leads - there is no public page to recover", () => {
    expect(LEAD_STAGES).not.toContain("enrich");
    expect(nextLeadStage("score")).toBe("draft");
  });

  it("treats done as a fixed point so a stuck row cannot loop forever", () => {
    expect(nextJobStage("done")).toBe("done");
    expect(nextLeadStage("done")).toBe("done");
  });

  it("gives every stage a defined successor", () => {
    for (const stage of JOB_STAGES) {
      expect(nextJobStage(stage)).toBeDefined();
    }
    for (const stage of LEAD_STAGES) {
      expect(nextLeadStage(stage)).toBeDefined();
    }
  });
});

describe("terminal statuses", () => {
  // The point of these: the worker must never resurrect a row a human closed.
  // If someone adds a status and forgets the terminal set, this is what catches it.
  it("treats human-closed job statuses as terminal", () => {
    expect(isJobTerminal("ignored")).toBe(true);
    expect(isJobTerminal("rejected")).toBe(true);
    expect(isJobTerminal("closed")).toBe(true);
  });

  it("does not treat in-flight job statuses as terminal", () => {
    for (const status of ["found", "matched", "ready_for_review", "sent", "responded", "interview", "offer"]) {
      expect(isJobTerminal(status)).toBe(false);
    }
  });

  it("treats won and lost leads as terminal but not responded", () => {
    expect(isLeadTerminal("won")).toBe(true);
    expect(isLeadTerminal("lost")).toBe(true);
    expect(isLeadTerminal("ignored")).toBe(true);
    expect(isLeadTerminal("responded")).toBe(false);
  });

  it("does not treat an unknown status as terminal", () => {
    // Fail open to "keep processing" rather than silently dropping a row whose
    // status we do not recognise.
    expect(isJobTerminal("something-new")).toBe(false);
    expect(isLeadTerminal("something-new")).toBe(false);
  });

  it("keeps the legacy 'pitched' lead status valid", () => {
    // Rows written before the stage machine used this. Dropping it would make
    // them fail validation on the status-update endpoint.
    expect(LEAD_STATUSES).toContain("pitched");
  });

  it("exposes the statuses the dashboard renders", () => {
    expect(JOB_STATUSES).toContain("applied");
    expect(JOB_STATUSES).toContain("ready_for_review");
  });
});

describe("retry backoff", () => {
  it("grows exponentially", () => {
    const one = nextAttemptDelayMs(1);
    const two = nextAttemptDelayMs(2);
    const three = nextAttemptDelayMs(3);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it("caps so a poisoned row never schedules itself years out", () => {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    // Well past the point where doubling would overflow anything sane.
    expect(nextAttemptDelayMs(50)).toBeLessThanOrEqual(SIX_HOURS + 17_000);
  });

  it("is deterministic for the same row so a retry lands in the same slot", () => {
    expect(nextAttemptDelayMs(3, 42)).toBe(nextAttemptDelayMs(3, 42));
  });

  it("spreads different rows failing in the same batch", () => {
    // Same attempt count, different ids -> different delays, so a batch of
    // failures does not stampede the same upstream on the next run.
    const delays = new Set([1, 2, 3, 4, 5].map((id) => nextAttemptDelayMs(2, id)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it("never returns a negative or zero delay", () => {
    for (const attempts of [0, 1, 2, 5, 100]) {
      expect(nextAttemptDelayMs(attempts)).toBeGreaterThan(0);
    }
  });

  it("schedules into the future relative to the supplied clock", () => {
    const now = new Date("2026-08-13T12:00:00Z");
    expect(nextAttemptAt(1, 0, now).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("attempt ceiling", () => {
  it("allows retries below the ceiling and stops at it", () => {
    expect(hasAttemptsLeft(0)).toBe(true);
    expect(hasAttemptsLeft(MAX_ATTEMPTS - 1)).toBe(true);
    expect(hasAttemptsLeft(MAX_ATTEMPTS)).toBe(false);
    expect(hasAttemptsLeft(MAX_ATTEMPTS + 1)).toBe(false);
  });
});
