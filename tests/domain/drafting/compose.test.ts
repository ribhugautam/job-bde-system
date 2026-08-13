import { describe, it, expect, vi, afterEach } from "vitest";
import { generateCoverLetter, generatePitch } from "@/lib/domain/drafting/compose";
import { SKILLS } from "@/lib/domain/scoring/resume-profile";
import type { RawJob, RawLead } from "@/lib/domain/types";
import { expectNoPlaceholderLeakage } from "./helpers";

// Every test in this file runs the template path. `fetch` is stubbed with a
// spy that throws so an accidental network call fails loudly instead of
// silently hitting the real Anthropic API from CI.
function stubFetchAsForbidden() {
  const fetchMock = vi.fn(() => {
    throw new Error("drafting made a network call on the template path");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AI_JOB: RawJob = {
  source: "test",
  sourceId: "job-1",
  title: "Senior AI Engineer",
  company: "Acme Robotics",
  url: "https://example.com/jobs/1",
  description:
    "You will build multi-agent LLM pipelines, a RAG retrieval layer and MCP integrations, " +
    "with a TypeScript and Next.js front end on top.",
  tags: ["llm", "rag"],
};

const MOBILE_JOB: RawJob = {
  source: "test",
  sourceId: "job-2",
  title: "Flutter Developer",
  company: "Bluebird Apps",
  url: "https://example.com/jobs/2",
  description:
    "Flutter and Dart mobile work against a Postgres backend, plus some Tailwind on the marketing site.",
};

const LEAD: RawLead = {
  source: "test",
  sourceId: "lead-1",
  title: "Build an AI agent dashboard in Next.js",
  clientOrCompany: "Northwind Studio",
  url: "https://example.com/leads/1",
  description: "Need a React/Next.js dashboard wired to an LLM agent backend. Ongoing contract.",
};

/** A skill "appears in" a job when its name or one of its aliases is present. */
function skillAppearsIn(skillName: string, haystack: string): boolean {
  const skill = SKILLS.find((s) => s.name === skillName);
  expect(skill, `emphasized "${skillName}" is not a known skill`).toBeDefined();
  const lower = haystack.toLowerCase();
  return [skill!.name, ...(skill!.aliases || [])].some((n) => lower.includes(n));
}

describe("generateCoverLetter - template path", () => {
  it("returns a template draft and makes no network call without an apiKey", async () => {
    const fetchMock = stubFetchAsForbidden();

    const draft = await generateCoverLetter(AI_JOB);

    expect(draft.generatedBy).toBe("template");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("behaves identically whether options are omitted or empty", async () => {
    stubFetchAsForbidden();

    const omitted = await generateCoverLetter(AI_JOB);
    const empty = await generateCoverLetter(AI_JOB, {});

    expect(empty).toEqual(omitted);
  });

  it("ignores ANTHROPIC_API_KEY in the environment", async () => {
    // The key is now a caller-supplied parameter. Domain code reading it back
    // out of the environment is the exact regression this guards.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-be-ignored");
    const fetchMock = stubFetchAsForbidden();

    const draft = await generateCoverLetter(AI_JOB);

    expect(draft.generatedBy).toBe("template");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(draft.text).not.toContain("sk-ant-should-be-ignored");
  });

  it("includes the job title and company", async () => {
    stubFetchAsForbidden();

    const draft = await generateCoverLetter(AI_JOB);

    expect(draft.text).toContain(AI_JOB.title);
    expect(draft.text).toContain(AI_JOB.company);
  });

  it("leaks no placeholders, including for a sparse job with no description", async () => {
    stubFetchAsForbidden();

    const full = await generateCoverLetter(AI_JOB);
    const sparse = await generateCoverLetter({
      source: "linkedin",
      sourceId: "job-3",
      title: "Full Stack Engineer",
      company: "Contoso",
      url: "https://example.com/jobs/3",
      sparse: true,
    });

    expectNoPlaceholderLeakage(full.text);
    expectNoPlaceholderLeakage(sparse.text);
    expect(sparse.text).toContain("Full Stack Engineer");
  });

  it("derives emphasizedSkills from the job rather than a fixed list", async () => {
    stubFetchAsForbidden();

    const ai = await generateCoverLetter(AI_JOB);
    const mobile = await generateCoverLetter(MOBILE_JOB);

    expect(ai.emphasizedSkills.length).toBeGreaterThan(0);
    expect(mobile.emphasizedSkills.length).toBeGreaterThan(0);
    expect(ai.emphasizedSkills).not.toEqual(mobile.emphasizedSkills);

    // Nothing emphasized that the job never mentions.
    const aiText = `${AI_JOB.title} ${AI_JOB.description} ${AI_JOB.tags?.join(" ")}`;
    for (const skill of ai.emphasizedSkills) {
      expect(skillAppearsIn(skill, aiText), `"${skill}" is not in the AI job`).toBe(true);
    }
    const mobileText = `${MOBILE_JOB.title} ${MOBILE_JOB.description}`;
    for (const skill of mobile.emphasizedSkills) {
      expect(skillAppearsIn(skill, mobileText), `"${skill}" is not in the mobile job`).toBe(true);
    }

    // And the ones the job leans on hardest do get picked up.
    expect(ai.emphasizedSkills).toEqual(expect.arrayContaining(["llm", "rag", "multi-agent"]));
    expect(mobile.emphasizedSkills).toContain("flutter");
    expect(mobile.emphasizedSkills).not.toContain("llm");
  });

  it("returns an empty skill list, not a filler one, for a job with no matches", async () => {
    stubFetchAsForbidden();

    const draft = await generateCoverLetter({
      source: "test",
      sourceId: "job-4",
      title: "Underwater Basket Weaver",
      company: "Deep Blue Crafts",
      url: "https://example.com/jobs/4",
      description: "Weaving baskets, underwater.",
    });

    expect(draft.emphasizedSkills).toEqual([]);
    expectNoPlaceholderLeakage(draft.text);
  });
});

describe("generatePitch - template path", () => {
  it("returns a template draft and makes no network call without an apiKey", async () => {
    const fetchMock = stubFetchAsForbidden();

    const draft = await generatePitch(LEAD);

    expect(draft.generatedBy).toBe("template");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes the lead title and client, and leaks no placeholders", async () => {
    stubFetchAsForbidden();

    const draft = await generatePitch(LEAD);

    expect(draft.text).toContain(LEAD.title);
    expect(draft.text).toContain(LEAD.clientOrCompany!);
    expectNoPlaceholderLeakage(draft.text);
  });

  it("leaks no placeholders when the client and description are missing", async () => {
    stubFetchAsForbidden();

    const draft = await generatePitch({
      source: "upwork",
      sourceId: "lead-2",
      title: "React developer needed",
      url: "https://example.com/leads/2",
    });

    expectNoPlaceholderLeakage(draft.text);
    expect(draft.text).toContain("React developer needed");
  });

  it("derives emphasizedSkills from the lead", async () => {
    stubFetchAsForbidden();

    const draft = await generatePitch(LEAD);

    const leadText = `${LEAD.title} ${LEAD.description}`;
    expect(draft.emphasizedSkills.length).toBeGreaterThan(0);
    for (const skill of draft.emphasizedSkills) {
      expect(skillAppearsIn(skill, leadText), `"${skill}" is not in the lead`).toBe(true);
    }
    expect(draft.emphasizedSkills).toContain("llm");
  });
});

describe("apiKey is a parameter, not an environment read", () => {
  it("calls Anthropic with the caller-supplied key and marks the draft as claude", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "AI-written body\n\nThanks," }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const draft = await generateCoverLetter(AI_JOB, { apiKey: "sk-ant-test" });

    expect(draft.generatedBy).toBe("claude");
    expect(draft.text).toContain("AI-written body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  });

  it("falls back to the template when the API call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    const draft = await generatePitch(LEAD, { apiKey: "sk-ant-test" });

    expect(draft.generatedBy).toBe("template");
    expect(draft.text).toContain(LEAD.title);
  });
});
