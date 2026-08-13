import { describe, it, expect } from "vitest";
import {
  composeFollowUp,
  type FollowUpInput,
  type FollowUpKind,
  type FollowUpStep,
} from "@/lib/domain/drafting/compose";
import { LINKS } from "@/lib/domain/scoring/resume-profile";
import { expectNoPlaceholderLeakage } from "./helpers";

const BASE: FollowUpInput = {
  kind: "application",
  step: 1,
  roleTitle: "Senior Full-Stack Engineer",
  company: "Acme Robotics",
  originalSubject: "Application: Senior Full-Stack Engineer",
  daysSince: 4,
};

function followUp(overrides: Partial<FollowUpInput> = {}) {
  return composeFollowUp({ ...BASE, ...overrides });
}

/** The prose before the sign-off - what the recipient actually has to read. */
function body(text: string): string {
  return text.split(/\n\n(?:Thanks|Best),/)[0].replace(/^Hi,\s*/, "");
}

/** Body sentences, with URLs masked so link dots don't read as full stops. */
function sentences(text: string): string[] {
  return body(text)
    .replace(/https?:\/\/\S+/g, "LINK")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALL_VARIANTS: { kind: FollowUpKind; step: FollowUpStep }[] = [
  { kind: "application", step: 1 },
  { kind: "application", step: 2 },
  { kind: "outreach", step: 1 },
  { kind: "outreach", step: 2 },
];

describe("composeFollowUp - subject threading", () => {
  it("prefixes the original subject with Re:", () => {
    expect(followUp().subject).toBe("Re: Application: Senior Full-Stack Engineer");
  });

  it("does not double-prefix a subject that already starts with Re:", () => {
    const subject = followUp({ originalSubject: "Re: Application: Senior Full-Stack Engineer" }).subject;
    expect(subject).toBe("Re: Application: Senior Full-Stack Engineer");
    expect(subject).not.toMatch(/Re:\s*Re:/i);
  });

  it.each([
    "RE: Application: Senior Full-Stack Engineer",
    "re: Application: Senior Full-Stack Engineer",
    "Re:Application: Senior Full-Stack Engineer",
    "Re: Re: Re: Application: Senior Full-Stack Engineer",
  ])("collapses an existing reply chain (%s)", (originalSubject) => {
    const subject = followUp({ originalSubject }).subject;
    expect(subject).toBe("Re: Application: Senior Full-Stack Engineer");
    expect(subject.match(/re\s*:/gi)).toHaveLength(1);
  });

  it("falls back to a role/company subject when the original is missing", () => {
    expect(followUp({ originalSubject: "" }).subject).toBe(
      "Re: Application - Senior Full-Stack Engineer (Acme Robotics)"
    );
    expect(followUp({ kind: "outreach", originalSubject: "   " }).subject).toBe(
      "Re: Senior Full-Stack Engineer (Acme Robotics)"
    );
    // A subject that is *only* a reply prefix leaves nothing to thread on.
    expect(followUp({ originalSubject: "Re:" }).subject).toBe(
      "Re: Application - Senior Full-Stack Engineer (Acme Robotics)"
    );
  });
});

describe("composeFollowUp - step 1 vs step 2", () => {
  it.each<FollowUpKind>(["application", "outreach"])(
    "produces materially different text per step (%s)",
    (kind) => {
      const first = followUp({ kind, step: 1, daysSince: 4 }).text;
      const final = followUp({ kind, step: 2, daysSince: 10 }).text;

      expect(first).not.toBe(final);
      // Materially different, not a reshuffle: the two bodies must not share a
      // single whole sentence.
      const firstSentences = new Set(sentences(first));
      const reused = sentences(final).filter((s) => firstSentences.has(s));
      expect(reused, `step 2 reuses step 1 sentences: ${reused.join(" / ")}`).toEqual([]);
    }
  );

  it.each<FollowUpKind>(["application", "outreach"])(
    "makes step 2 read as final and step 1 not (%s)",
    (kind) => {
      const first = followUp({ kind, step: 1, daysSince: 4 }).text;
      const final = followUp({ kind, step: 2, daysSince: 10 }).text;

      expect(final).toMatch(/\b(final|last)\b/i);
      expect(first).not.toMatch(/\b(final|last)\b/i);
    }
  );

  it("never promises further contact in the final message", () => {
    for (const { kind } of ALL_VARIANTS.filter((v) => v.step === 2)) {
      const text = followUp({ kind, step: 2, daysSince: 10 }).text;
      expect(text).not.toMatch(/i(?:'ll| will)\s+(?:follow up|check back|reach out|be in touch|ping|circle back)/i);
      expect(text).not.toMatch(/next week|in a few days|touch base/i);
    }
  });

  it("avoids guilt-tripping, fake urgency and inbox-bumping cliches", () => {
    for (const { kind, step } of ALL_VARIANTS) {
      const text = followUp({ kind, step, daysSince: step === 1 ? 4 : 10 }).text;
      expect(text).not.toMatch(/bump(?:ing)?\b|top of your inbox|just checking in|as per my (?:last|previous)/i);
      expect(text).not.toMatch(/\burgent|asap|last chance|act (?:now|fast)|don't miss/i);
      expect(text).not.toMatch(/i (?:know )?you'?re (?:probably )?busy|i understand you'?re busy|hate to (?:bother|pester)/i);
    }
  });
});

describe("composeFollowUp - brevity", () => {
  it.each(ALL_VARIANTS)("keeps $kind step $step to at most 5 sentences", ({ kind, step }) => {
    const { text } = followUp({ kind, step, daysSince: step === 1 ? 4 : 10 });
    const count = sentences(text).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count, `too long:\n${text}`).toBeLessThanOrEqual(5);
  });

  it.each(ALL_VARIANTS)("keeps the $kind step $step body short in characters", ({ kind, step }) => {
    const { text } = followUp({ kind, step, daysSince: step === 1 ? 4 : 10 });
    // A follow-up that restates the cover letter is worse than none, and the
    // originals run 900+ characters of body.
    expect(body(text).length, `too long:\n${text}`).toBeLessThanOrEqual(400);
    expect(text.length).toBeLessThanOrEqual(700);
  });
});

describe("composeFollowUp - content", () => {
  it.each(ALL_VARIANTS)("names the role and company in $kind step $step", ({ kind, step }) => {
    const { text } = followUp({ kind, step });
    expect(text).toContain("Senior Full-Stack Engineer");
    expect(text).toContain("Acme Robotics");
  });

  it.each(ALL_VARIANTS)("reads cleanly with no company in $kind step $step", ({ kind, step }) => {
    const { text } = followUp({ kind, step, company: undefined });
    expect(text).toContain("Senior Full-Stack Engineer");
    expect(text).not.toMatch(/\(\s*\)|\s{2,}[a-z]|\bat\s*[.,]/);
    expectNoPlaceholderLeakage(text);
  });

  it("treats a blank company the same as no company", () => {
    expect(followUp({ company: "   " }).text).toBe(followUp({ company: undefined }).text);
  });

  it("references the previous message without inventing anything else", () => {
    const { text } = followUp({ daysSince: 4 });
    expect(text).toContain("4 days ago");
    // No fabricated relationships, calls or deadlines.
    expect(text).not.toMatch(/mutual (?:friend|connection|contact)|we spoke|our (?:call|conversation)|as discussed|referred (?:me|by)/i);
    expect(text).not.toMatch(/deadline|before (?:friday|monday|the end of)/i);
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    "omits the elapsed-time phrase for an unusable daysSince (%s)",
    (daysSince) => {
      const { text } = followUp({ daysSince });
      expect(text).not.toMatch(/days ago|yesterday/);
      expectNoPlaceholderLeakage(text);
    }
  );

  it("says 'yesterday' rather than '1 days ago'", () => {
    const { text } = followUp({ daysSince: 1 });
    expect(text).toContain("yesterday");
    expect(text).not.toContain("1 days ago");
  });
});

describe("composeFollowUp - CV and link policy", () => {
  it.each<FollowUpStep>([1, 2])("never mentions a CV or attachment in outreach step %s", (step) => {
    const { text } = followUp({ kind: "outreach", step, daysSince: step === 1 ? 4 : 10 });
    expect(text).not.toMatch(/\bcv\b|resum(?:e|é)|attach(?:ed|ment)?\b|\bpdf\b/i);
  });

  it.each<FollowUpStep>([1, 2])("may reference the CV in application step %s", (step) => {
    const { text } = followUp({ kind: "application", step, daysSince: step === 1 ? 4 : 10 });
    expect(text).toMatch(/\bCV\b/);
  });

  it("gives cold outreach a portfolio link instead", () => {
    const { text } = followUp({ kind: "outreach", step: 1 });
    expect(text).toContain(LINKS.portfolio);
  });

  it.each(ALL_VARIANTS)("never leaks a GitHub URL in $kind step $step", ({ kind, step }) => {
    // Deliberate standing decision: GitHub is excluded from all outreach
    // because the pinned repos are student projects.
    const { text } = followUp({ kind, step });
    expect(text).not.toContain(LINKS.github);
    expect(text).not.toMatch(/github/i);
  });

  it("uses the real contact details from the resume profile", () => {
    const { text } = followUp();
    expect(text).toContain(LINKS.email);
    expect(text).toContain(LINKS.linkedin);
  });
});

describe("composeFollowUp - placeholder leakage", () => {
  it.each(ALL_VARIANTS)("emits no placeholders for $kind step $step", ({ kind, step }) => {
    const { subject, text } = followUp({ kind, step, daysSince: step === 1 ? 4 : 10 });
    expectNoPlaceholderLeakage(subject);
    expectNoPlaceholderLeakage(text);
  });

  it("emits no placeholders when every optional field is absent", () => {
    const { subject, text } = composeFollowUp({
      kind: "outreach",
      step: 2,
      roleTitle: "React Developer",
      originalSubject: "",
      daysSince: 0,
    });
    expectNoPlaceholderLeakage(subject);
    expectNoPlaceholderLeakage(text);
    expect(subject).toBe("Re: React Developer");
    expect(text).toContain("React Developer");
  });
});
