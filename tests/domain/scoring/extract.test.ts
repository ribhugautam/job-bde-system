import { describe, expect, it } from "vitest";
import {
  extractCareerStart,
  extractProfile,
  extractSkills,
  extractTargetRoles,
} from "@/lib/domain/scoring/extract";
import { defaultProfile } from "@/lib/domain/scoring/profile";

const NOW = new Date("2026-08-21T00:00:00Z");

/** A realistic backend resume that shares almost nothing with the default profile. */
const GO_RESUME = `
Priya Raman
Senior Backend Engineer

EXPERIENCE
Backend Engineer, Fintech Co - Mar 2019 - Present
  Built payment services in Go and Java (Spring Boot), deployed on Kubernetes.
  Designed Kafka event pipelines and PostgreSQL schemas for ledger data.
  Go services handle 40k requests per second. Wrote Go tooling for migrations.

Software Engineer, Retail Systems - Jun 2016 - Feb 2019
  Maintained a Django monolith with Redis caching and Docker deployments.
  Introduced Terraform for infrastructure provisioning.

EDUCATION
B.E. Computer Science, 2016
`.trim();

const LOW_TEXT = "Priya Raman\nSenior Engineer";

describe("extractSkills", () => {
  it("finds skills the resume actually names", () => {
    const names = extractSkills(GO_RESUME.toLowerCase()).map((s) => s.name);
    expect(names).toContain("go");
    expect(names).toContain("java");
    expect(names).toContain("kubernetes");
    expect(names).toContain("kafka");
    expect(names).toContain("postgresql");
    expect(names).toContain("django");
    expect(names).toContain("terraform");
    expect(names).toContain("redis");
    expect(names).toContain("docker");
  });

  it("does not invent skills the resume never mentions", () => {
    const names = extractSkills(GO_RESUME.toLowerCase()).map((s) => s.name);
    // The bias is toward under-claiming: a missed skill costs one correction,
    // a wrongly claimed one silently inflates every score mentioning it.
    expect(names).not.toContain("flutter");
    expect(names).not.toContain("react");
    expect(names).not.toContain("next.js");
  });

  it("matches on whole tokens, never substrings", () => {
    // "go" inside "category", "ml" inside "html", "ts" inside "documents",
    // "rag" inside "storage". A resume is dense with exactly these words, so
    // substring matching is not a rare edge case here but the common one.
    const trap = "managed documents and storage for each category in html".toLowerCase();
    const names = extractSkills(trap).map((s) => s.name);
    expect(names).not.toContain("go");
    expect(names).not.toContain("machine learning");
    expect(names).not.toContain("typescript");
    expect(names).not.toContain("rag");
  });

  it("weights an emphasised skill above its taxonomy default", () => {
    // "Go" appears four times in GO_RESUME; Java twice.
    const skills = extractSkills(GO_RESUME.toLowerCase());
    const go = skills.find((s) => s.name === "go");
    const terraform = skills.find((s) => s.name === "terraform");
    expect(go!.weight).toBeGreaterThan(terraform!.weight);
  });

  it("caps the emphasis bonus so a stuffed resume cannot run away", () => {
    const stuffed = "react ".repeat(200);
    const react = extractSkills(stuffed).find((s) => s.name === "react");
    expect(react!.weight).toBeLessThanOrEqual(5);
  });
});

describe("extractCareerStart", () => {
  it("takes the earliest month-anchored date", () => {
    expect(extractCareerStart(GO_RESUME.toLowerCase(), NOW)).toEqual(
      new Date(Date.UTC(2016, 5, 1))
    );
  });

  it("ignores bare years, which are usually education or noise", () => {
    // "B.E. Computer Science, 2016" must not become a career start, and neither
    // must "99.9% uptime" or "top 500". Requiring a month is what separates
    // employment ranges from degrees.
    expect(extractCareerStart("graduated 2011. 99.9% uptime across 2000 users.", NOW)).toBeNull();
  });

  it("returns null when there is no date at all, rather than guessing", () => {
    expect(extractCareerStart("senior engineer, backend systems", NOW)).toBeNull();
  });

  it("ignores years outside a plausible working range", () => {
    expect(extractCareerStart("jan 1854 - dec 1860 blacksmith", NOW)).toBeNull();
    expect(extractCareerStart("mar 2099 - present time traveller", NOW)).toBeNull();
  });

  it("accepts abbreviated and full month names", () => {
    expect(extractCareerStart("september 2020 - present", NOW)).toEqual(
      new Date(Date.UTC(2020, 8, 1))
    );
    expect(extractCareerStart("sept. 2020 - present", NOW)).toEqual(
      new Date(Date.UTC(2020, 8, 1))
    );
  });
});

describe("extractTargetRoles", () => {
  it("recognises titles the resume names, with words in between", () => {
    const roles = extractTargetRoles("Senior Backend Engineer, Platform".toLowerCase());
    expect(roles).toContain("backend engineer");
  });

  it("never turns a vetoed role into a target", () => {
    // A resume can legitimately mention sales engineering; that does not make
    // it something this tool should rank up.
    const roles = extractTargetRoles(
      "sales engineer and business development manager".toLowerCase()
    );
    expect(roles).toEqual([]);
  });
});

describe("extractProfile", () => {
  it("produces a profile that differs from the default", () => {
    const { profile } = extractProfile(GO_RESUME, NOW);
    const defaults = defaultProfile();
    expect(profile.skills.map((s) => s.name)).not.toEqual(
      defaults.skills.map((s) => s.name)
    );
    expect(profile.careerStart).toEqual(new Date(Date.UTC(2016, 5, 1)));
  });

  it("never extracts arrangement preferences, which a resume cannot state", () => {
    const { profile } = extractProfile(GO_RESUME, NOW);
    expect(profile.acceptedArrangements).toEqual(defaultProfile().acceptedArrangements);
  });

  it("keeps veto phrases as shared policy rather than reading them off a CV", () => {
    const { profile } = extractProfile(GO_RESUME, NOW);
    expect(profile.vetoPhrases).toEqual(defaultProfile().vetoPhrases);
  });

  it("flags an unreadable PDF as low confidence and falls back to the default", () => {
    // An image-only scan yields almost no text. Falling back to an EMPTY
    // profile would score every job 0, which reads as a broken app rather than
    // a failed upload -- so the default is used and the flag says why.
    const { profile, found } = extractProfile(LOW_TEXT, NOW);
    expect(found.lowConfidence).toBe(true);
    expect(profile.skills).toEqual(defaultProfile().skills);
  });

  it("reports what it found so the UI can show it rather than hide it", () => {
    const { found } = extractProfile(GO_RESUME, NOW);
    expect(found.lowConfidence).toBe(false);
    expect(found.skills.length).toBeGreaterThan(5);
    expect(found.careerStart).toEqual(new Date(Date.UTC(2016, 5, 1)));
  });
});
