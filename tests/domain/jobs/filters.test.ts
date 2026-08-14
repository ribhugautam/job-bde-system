import { describe, it, expect } from "vitest";
import {
  parseJobFilters,
  serializeJobFilters,
  toggleInList,
  DEFAULT_JOB_FILTERS,
} from "@/lib/domain/jobs/filters";

const parse = (qs: string) => parseJobFilters(new URLSearchParams(qs));

describe("parseJobFilters", () => {
  it("returns the defaults for an empty query string", () => {
    expect(parse("")).toEqual(DEFAULT_JOB_FILTERS);
  });

  it("hides dismissed jobs by default", () => {
    expect(DEFAULT_JOB_FILTERS.showDismissed).toBe(false);
  });

  it("sorts by score by default", () => {
    expect(DEFAULT_JOB_FILTERS.sort).toBe("score");
  });

  it("reads repeated params into a list", () => {
    expect(parse("eligibility=eligible&eligibility=worldwide").eligibility).toEqual([
      "eligible",
      "worldwide",
    ]);
  });

  it("reads a comma-separated list too", () => {
    expect(parse("arrangement=remote,hybrid").arrangement).toEqual(["remote", "hybrid"]);
  });

  // These values arrive from a URL a human can edit. Parsing is total: an
  // unrecognised value is DROPPED, never thrown on, and never passed to SQL.
  it("drops an unknown eligibility value instead of throwing", () => {
    expect(parse("eligibility=eligible&eligibility=banana").eligibility).toEqual(["eligible"]);
  });

  it("drops an unknown arrangement value", () => {
    expect(parse("arrangement=teleport").arrangement).toEqual([]);
  });

  it("ignores a non-numeric score", () => {
    expect(parse("minScore=abc").minScore).toBeUndefined();
  });

  it("clamps a score outside 0-100", () => {
    expect(parse("minScore=-5").minScore).toBe(0);
    expect(parse("minScore=500").minScore).toBe(100);
  });

  it("falls back to the default sort for an unknown sort key", () => {
    expect(parse("sort=sideways").sort).toBe("score");
  });

  it("reads the boolean flags", () => {
    expect(parse("easyApply=1").easyApplyOnly).toBe(true);
    expect(parse("dismissed=1").showDismissed).toBe(true);
    expect(parse("easyApply=0").easyApplyOnly).toBe(false);
  });

  it("trims a blank query to undefined", () => {
    expect(parse("q=%20%20").query).toBeUndefined();
    expect(parse("q=react").query).toBe("react");
  });
});

describe("serializeJobFilters", () => {
  it("omits every default so a clean view has a clean URL", () => {
    expect(serializeJobFilters(DEFAULT_JOB_FILTERS).toString()).toBe("");
  });

  it("round-trips a populated filter set", () => {
    const filters = {
      ...DEFAULT_JOB_FILTERS,
      eligibility: ["eligible" as const],
      arrangement: ["remote" as const],
      sources: ["linkedin_alert"],
      minScore: 40,
      easyApplyOnly: true,
      query: "react",
      showDismissed: true,
      sort: "newest" as const,
    };
    expect(parseJobFilters(serializeJobFilters(filters))).toEqual(filters);
  });

  it("writes lists comma-separated rather than repeating the key", () => {
    const qs = serializeJobFilters({
      ...DEFAULT_JOB_FILTERS,
      eligibility: ["eligible", "worldwide"],
    }).toString();
    expect(decodeURIComponent(qs)).toBe("eligibility=eligible,worldwide");
  });
});

describe("toggleInList", () => {
  it("adds a value that is absent", () => {
    expect(toggleInList(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes a value that is present", () => {
    expect(toggleInList(["a", "b"], "a")).toEqual(["b"]);
  });

  it("does not mutate the input", () => {
    const input = ["a"];
    toggleInList(input, "b");
    expect(input).toEqual(["a"]);
  });
});
