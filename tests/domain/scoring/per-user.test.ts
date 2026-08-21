import { describe, expect, it } from "vitest";
import { scoreJob } from "@/lib/domain/scoring/score";
import {
  buildProfile,
  defaultProfile,
  yearsOfExperience,
  type ScoringProfile,
} from "@/lib/domain/scoring/profile";
import type { RawJob } from "@/lib/domain/types";

// ---------------------------------------------------------------------------
// The point of the whole feature: two people looking at the same job pool see
// it in different orders, because it is ranked against their own resume.
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: "test",
    sourceId: "job-1",
    title: "Engineer",
    company: "Acme",
    url: "https://example.invalid/job-1",
    ...overrides,
  };
}

const reactDev: ScoringProfile = {
  ...defaultProfile(),
  skills: [
    { name: "react", weight: 3, aliases: ["react.js", "reactjs"] },
    { name: "next.js", weight: 3, aliases: ["nextjs"] },
    { name: "typescript", weight: 3, aliases: ["ts"] },
  ],
  targetRoles: ["frontend engineer", "react developer"],
};

const goDev: ScoringProfile = {
  ...defaultProfile(),
  skills: [
    { name: "go", weight: 3, aliases: ["golang"] },
    { name: "kubernetes", weight: 2, aliases: ["k8s"] },
    { name: "postgresql", weight: 2, aliases: ["postgres"] },
  ],
  targetRoles: ["backend engineer"],
};

const FRONTEND_JOB = makeJob({
  title: "Frontend Engineer",
  description: "React, Next.js and TypeScript throughout.",
});

const BACKEND_JOB = makeJob({
  title: "Backend Engineer",
  description: "Go services on Kubernetes backed by Postgres.",
});

describe("the same job scored against different profiles", () => {
  it("ranks each person's own stack higher", () => {
    expect(scoreJob(FRONTEND_JOB, reactDev).score).toBeGreaterThan(
      scoreJob(FRONTEND_JOB, goDev).score
    );
    expect(scoreJob(BACKEND_JOB, goDev).score).toBeGreaterThan(
      scoreJob(BACKEND_JOB, reactDev).score
    );
  });

  it("puts the two job lists in opposite orders for the two people", () => {
    // Not just "different numbers" -- a different ORDER, which is what the user
    // actually experiences on a ranked list with no filters.
    const forReact = [FRONTEND_JOB, BACKEND_JOB]
      .map((job) => ({ job, score: scoreJob(job, reactDev).score }))
      .sort((a, b) => b.score - a.score);
    const forGo = [FRONTEND_JOB, BACKEND_JOB]
      .map((job) => ({ job, score: scoreJob(job, goDev).score }))
      .sort((a, b) => b.score - a.score);

    expect(forReact[0].job.title).toBe("Frontend Engineer");
    expect(forGo[0].job.title).toBe("Backend Engineer");
  });

  it("explains the score in terms of the viewer's own skills", () => {
    const { reasons } = scoreJob(BACKEND_JOB, goDev);
    expect(reasons).toContain("matches skill: go");
    expect(reasons).not.toContain("matches skill: react");
  });

  it("gives the title bonus only for that person's target roles", () => {
    expect(scoreJob(BACKEND_JOB, goDev).reasons).toContain(
      "title matches a targeted role"
    );
    expect(scoreJob(BACKEND_JOB, reactDev).reasons).not.toContain(
      "title matches a targeted role"
    );
  });
});

describe("arrangement preference", () => {
  const onsiteJob = makeJob({ arrangement: "onsite", description: "React and TypeScript." });

  it("penalises an arrangement the person does not accept", () => {
    const remoteOnly = { ...reactDev, acceptedArrangements: ["remote" as const] };
    expect(scoreJob(onsiteJob, remoteOnly).reasons.join(" ")).toMatch(/office presence/);
  });

  it("stops penalising it once they say they will take it", () => {
    const willCommute = {
      ...reactDev,
      acceptedArrangements: ["remote" as const, "onsite" as const],
    };
    const remoteOnly = { ...reactDev, acceptedArrangements: ["remote" as const] };
    expect(scoreJob(onsiteJob, willCommute).score).toBeGreaterThan(
      scoreJob(onsiteJob, remoteOnly).score
    );
  });
});

describe("careerStart and experience", () => {
  const seniorJob = makeJob({ minYears: 12, description: "React and TypeScript." });

  it("skips experience adjustments entirely when the career start is unknown", () => {
    // The honest outcome. Telling somebody a role "wants 12+ years, you have
    // ~0" because their resume did not parse is worse than saying nothing.
    const { reasons } = scoreJob(seniorJob, { ...reactDev, careerStart: null });
    expect(reasons.join(" ")).not.toMatch(/likely filtered out/);
    expect(reasons.join(" ")).toMatch(/add your career start date/);
  });

  it("applies the penalty once the career start is known", () => {
    const junior = { ...reactDev, careerStart: new Date("2024-01-01T00:00:00Z") };
    expect(scoreJob(seniorJob, junior).reasons.join(" ")).toMatch(/likely filtered out/);
  });
});

describe("yearsOfExperience", () => {
  it("is null for an unknown career start", () => {
    expect(yearsOfExperience(null)).toBeNull();
  });

  it("measures from the career start", () => {
    const years = yearsOfExperience(
      new Date("2020-08-21T00:00:00Z"),
      new Date("2026-08-21T00:00:00Z")
    );
    expect(years).toBeCloseTo(6, 1);
  });

  it("never returns a negative figure for a future date", () => {
    expect(
      yearsOfExperience(new Date("2030-01-01T00:00:00Z"), new Date("2026-08-21T00:00:00Z"))
    ).toBe(0);
  });
});

describe("buildProfile", () => {
  it("drops malformed values instead of throwing", () => {
    // Every field comes out of a JSON column a human could have edited. A bad
    // profile must rank jobs oddly, never 500 the job list.
    const profile = buildProfile({
      skills: [
        { name: "react", weight: 3 },
        { name: "", weight: 2 },
        { weight: 2 },
        "not an object",
        null,
      ],
      targetRoles: ["Frontend Engineer", 42, null],
      acceptedArrangements: ["remote", "teleport"],
    });

    expect(profile.skills.map((s) => s.name)).toEqual(["react"]);
    expect(profile.targetRoles).toEqual(["frontend engineer"]);
    expect(profile.acceptedArrangements).toEqual(["remote"]);
  });

  it("clamps an absurd weight rather than trusting it", () => {
    const profile = buildProfile({ skills: [{ name: "react", weight: 9999 }] });
    expect(profile.skills[0].weight).toBeLessThanOrEqual(10);
  });

  it("honours a deliberately empty skill list", () => {
    // A user who deleted every skill is not the same as a user who has none
    // yet, and silently restoring the defaults would undo their edit.
    expect(buildProfile({ skills: [] }).skills).toEqual([]);
  });

  it("falls back to defaults only when a value is missing or unusable", () => {
    const profile = buildProfile({ skills: "nonsense", targetRoles: undefined });
    const base = defaultProfile();
    expect(profile.skills).toEqual(base.skills);
    expect(profile.targetRoles).toEqual(base.targetRoles);
  });

  it("parses a career start from a stored string or Date", () => {
    expect(buildProfile({ careerStart: "2021-03-01" }).careerStart).toEqual(
      new Date("2021-03-01")
    );
    const date = new Date("2021-03-01T00:00:00Z");
    expect(buildProfile({ careerStart: date }).careerStart).toEqual(date);
    expect(buildProfile({ careerStart: "not a date" }).careerStart).toBeNull();
  });
});
