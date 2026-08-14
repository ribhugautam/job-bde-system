import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveArrangement } from "@/lib/domain/facts";
import { getEnv, resetEnvCache } from "@/lib/config/env";
import {
  BADGE_LINE_PATTERNS,
  fetchLinkedInAlerts,
  isNavigationText,
  parseAlertEmail,
} from "@/lib/infra/linkedin/alerts";

// ---------------------------------------------------------------------------
// parseAlertEmail is the single most breakage-prone function in the codebase:
// LinkedIn changes these email templates without notice and nothing else tells
// us when it happens. These tests pin the contract against hand-written
// fixtures that mirror the real template shape - nested presentation tables,
// each field in its own <div> with no whitespace between them, several
// tracking-laden anchors per job, and navigation chrome mixed in.
//
// When LinkedIn does change the template, the honest fix is to save the new
// email into tests/fixtures/linkedin/ and make the parser satisfy both.
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/linkedin");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// The enable flag used to be compared against the literal string "1" here
// while the source registry gated on the validated boolean from getEnv().
// ENABLE_LINKEDIN_ALERTS=true therefore enabled the source in the registry and
// then returned zero jobs from this module - a source that looks switched on
// and silently produces nothing. Both sides now read the same accessor.
// ---------------------------------------------------------------------------
describe("fetchLinkedInAlerts - the enable flag", () => {
  it("accepts every truthy spelling getEnv() accepts, not just \"1\"", async () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "  yes  "]) {
      vi.stubEnv("ENABLE_LINKEDIN_ALERTS", value);
      vi.stubEnv("IMAP_USER", "");
      vi.stubEnv("IMAP_PASSWORD", "");
      vi.stubEnv("GMAIL_USER", "");
      vi.stubEnv("GMAIL_APP_PASSWORD", "");
      resetEnvCache();

      expect(getEnv().ENABLE_LINKEDIN_ALERTS, `for value "${value}"`).toBe(true);
      // Getting past the flag means reaching the credentials check. Without
      // credentials that throws, which is exactly how we know the source was
      // enabled rather than silently short-circuited to [].
      await expect(fetchLinkedInAlerts()).rejects.toThrow(/no IMAP credentials/i);
    }
  });

  it("stays off when unset or explicitly disabled, without touching IMAP", async () => {
    for (const value of [undefined, "", "0", "false", "no", "off"]) {
      // undefined deletes the key, so this holds even on a machine that has
      // the flag exported in its shell.
      vi.stubEnv("ENABLE_LINKEDIN_ALERTS", value);
      resetEnvCache();

      expect(getEnv().ENABLE_LINKEDIN_ALERTS, `for value "${value}"`).toBe(false);
      await expect(fetchLinkedInAlerts()).resolves.toEqual([]);
    }
  });
});

describe("parseAlertEmail - multi-job digest", () => {
  const jobs = parseAlertEmail(fixture("digest-multi-job.html"));

  it("finds every job in the digest exactly once", () => {
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.id)).toEqual([
      "3812345678",
      "3900112233",
      "3745559001",
    ]);
  });

  it("extracts title, company and location for each job", () => {
    expect(jobs[0]).toEqual({
      id: "3812345678",
      title: "Senior Full Stack Engineer",
      company: "Vercel",
      location: "Remote, Worldwide",
      arrangement: "remote",
      easyApply: false,
    });
    expect(jobs[2]).toEqual({
      id: "3745559001",
      title: "Full Stack Developer (Next.js)",
      company: "Supabase",
      location: "Remote",
      arrangement: "remote",
      easyApply: false,
    });
  });

  it("keeps a title that LinkedIn split across nested spans in one piece", () => {
    expect(jobs[1].title).toBe("Staff Product Engineer – React & TypeScript");
    expect(jobs[1].company).toBe("Linear");
    expect(jobs[1].location).toBe("London, England, United Kingdom (Hybrid)");
    // Hybrid is not remote, whatever the source is called.
    expect(jobs[1].arrangement).toBe("hybrid");
  });

  it("never returns navigation chrome as a job", () => {
    const titles = jobs.map((j) => j.title);
    expect(titles).not.toContain("View job");
    expect(titles).not.toContain("See all jobs");
    expect(titles).not.toContain("Unsubscribe");
    expect(titles).not.toContain("3 new jobs");
    // The header/footer links point at /jobs/search/ and /psettings/, so they
    // must not produce ids either.
    expect(jobs.every((j) => /^\d+$/.test(j.id))).toBe(true);
  });

  it("does not leak tracking parameters into any field", () => {
    for (const j of jobs) {
      const blob = `${j.id}${j.title}${j.company}${j.location ?? ""}`;
      expect(blob).not.toMatch(/trackingId|trkEmail|midToken|refId/i);
    }
  });
});

describe("parseAlertEmail - the glued-text trap", () => {
  const html = fixture("glued-fields.html");

  it("the fixture really does glue company and location together", () => {
    // Guards the test itself: if someone reformats the fixture, the naive
    // .text() no longer glues and the regression test below stops meaning
    // anything. This asserts the trap is still armed.
    const $ = cheerio.load(html);
    expect($("td").text().replace(/\s+/g, " ")).toContain(
      "VercelRemote, Worldwide"
    );
  });

  it("splits adjacent divs into separate company and location", () => {
    const [job] = parseAlertEmail(html);
    expect(job.company).toBe("Vercel");
    expect(job.location).toBe("Remote, Worldwide");
    expect(job.company).not.toContain("Remote");
    expect(job.title).toBe("Senior Full Stack Engineer");
  });

  it("returns no field containing the glued string", () => {
    for (const job of parseAlertEmail(html)) {
      expect(Object.values(job).join("|")).not.toContain("VercelRemote");
    }
  });
});

describe("parseAlertEmail - duplicate anchors for one job", () => {
  const jobs = parseAlertEmail(fixture("duplicate-anchors.html"));

  it("collapses logo, title, company and CTA links into one job", () => {
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("3812345678");
  });

  it("keeps the richest anchor text as the title", () => {
    expect(jobs[0].title).toBe(
      "Senior Full Stack Engineer, Developer Experience"
    );
    // Not the logo's alt text, not the company link, not the button.
    expect(jobs[0].title).not.toBe("Vercel logo");
    expect(jobs[0].title).not.toBe("Vercel");
    expect(jobs[0].title).not.toBe("View job");
  });

  it("still resolves company and location off the winning anchor", () => {
    expect(jobs[0].company).toBe("Vercel");
    expect(jobs[0].location).toBe("Remote, Worldwide");
  });
});

describe("parseAlertEmail - navigation-only email", () => {
  it("returns nothing when every job link is a CTA or a counter", () => {
    // These anchors DO carry /jobs/view/<id> hrefs, so only the CTA text
    // filter can reject them - de-duplication cannot.
    expect(parseAlertEmail(fixture("cta-only.html"))).toEqual([]);
  });
});

describe("parseAlertEmail - malformed input", () => {
  it("returns [] for an empty string", () => {
    expect(parseAlertEmail("")).toEqual([]);
  });

  it("returns [] for HTML with no LinkedIn job links", () => {
    expect(
      parseAlertEmail("<html><body><p>Your alert had no new jobs.</p></body></html>")
    ).toEqual([]);
  });

  it("returns [] for a truncated email without throwing", () => {
    expect(() => parseAlertEmail(fixture("malformed.html"))).not.toThrow();
    expect(parseAlertEmail(fixture("malformed.html"))).toEqual([]);
  });

  it("survives a plain-text fallback body", () => {
    // fetchLinkedInAlerts falls back to `<pre>${mail.text}</pre>` when the
    // message has no HTML part, so that shape must not throw either.
    const text =
      "<pre>Senior Full Stack Engineer - Vercel\nhttps://www.linkedin.com/jobs/view/3812345678/</pre>";
    expect(() => parseAlertEmail(text)).not.toThrow();
    expect(parseAlertEmail(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX 1: the navigation filter used to prefix-match single words, so any job
// whose title merely STARTED with "manage", "help", "apply", "settings" or
// "linkedin" was silently discarded. These are the jobs that were being lost.
// ---------------------------------------------------------------------------
describe("parseAlertEmail - titles that start with a navigation word", () => {
  const jobs = parseAlertEmail(fixture("trapped-titles.html"));

  it("keeps every job whose title merely begins with a navigation word", () => {
    expect(jobs.map((j) => j.title)).toEqual([
      "Manager, Platform Engineering",
      "Help Desk Engineer",
      "Applied Scientist, Search Relevance",
      "LinkedIn Marketing Specialist",
      "Settings & Privacy Engineer",
      "Viewer Experience Producer",
    ]);
  });

  it("still resolves their company and location", () => {
    expect(jobs.map((j) => j.company)).toEqual([
      "Datadog",
      "Atlassian",
      "Amazon",
      "HubSpot",
      "Mozilla",
      "Sky",
    ]);
    expect(jobs[1].location).toBe("Sydney, NSW (On-site)");
  });

  it("still rejects the CTA anchors sitting next to those titles", () => {
    // Each card carries a real navigation anchor on the same job id.
    expect(jobs).toHaveLength(6);
    for (const j of jobs) {
      expect(["View job", "Apply now", "See all jobs", "Easy Apply", "Show more"]).not.toContain(
        j.title
      );
    }
  });
});

describe("isNavigationText", () => {
  it("proves the pattern it replaced really was dropping these jobs", () => {
    // The exact regex that used to guard the anchor loop. Kept here as
    // evidence, the same way the glued-text fixture keeps its trap armed: if
    // someone reintroduces prefix matching, the second half of this test
    // starts failing.
    const OLD_CTA_RE =
      /^(see all|view all|view job|apply|unsubscribe|manage|settings|help|linkedin|see more|show more|\d+ new jobs?)/i;
    const lostJobs = [
      "Manager, Platform Engineering",
      "Help Desk Engineer",
      "Helpdesk Support Specialist",
      "LinkedIn Marketing Specialist",
      "Settings & Privacy Engineer",
      "Apply Engineering Lead",
    ];
    for (const title of lostJobs) {
      expect(OLD_CTA_RE.test(title), `old pattern dropped "${title}"`).toBe(true);
      expect(isNavigationText(title), `new pattern keeps "${title}"`).toBe(false);
    }

    // Correcting my own earlier claim: "Applied Scientist" was NOT affected -
    // "appli" is not the prefix "apply". The words that actually bit were
    // manage / help / settings / linkedin, which are common title openers.
    expect(OLD_CTA_RE.test("Applied Scientist, Search Relevance")).toBe(false);
  });

  it("rejects text that IS navigation", () => {
    for (const nav of [
      "See all jobs",
      "See all",
      "See all 12 new jobs",
      "View all jobs",
      "View job",
      "View this job",
      "See more",
      "Show more",
      "Apply",
      "Apply now",
      "Easy Apply",
      "Apply on company website",
      "Unsubscribe",
      "Manage email preferences",
      "Manage",
      "Settings",
      "Help",
      "Help Center",
      "LinkedIn",
      "12 new jobs",
      "1 new job",
      "See all jobs ›",
      "Apply now →",
      "   ",
    ]) {
      expect(isNavigationText(nav), `expected "${nav}" to be navigation`).toBe(true);
    }
  });

  it("keeps real titles that share a first word with navigation", () => {
    for (const title of [
      "Manager, Platform Engineering",
      "Engineering Manager",
      "Help Desk Engineer",
      "Helpdesk Support Specialist",
      "Applied Scientist",
      "Applications Engineer",
      "Application Security Engineer",
      "Settings & Privacy Engineer",
      "LinkedIn Marketing Specialist",
      "Viewer Experience Producer",
      "New Business Development Manager",
      "Show Producer",
      "Newsroom Engineer",
    ]) {
      expect(isNavigationText(title), `expected "${title}" to survive`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 2: `remote` was hardcoded true for every alert job, which handed a
// remote bonus to on-site roles and told the reader "remote" about a job in a
// London office. It is now derived, and undefined when the email is silent.
// ---------------------------------------------------------------------------
describe("deriveArrangement on LinkedIn location lines", () => {
  const at = (location?: string) => deriveArrangement({ location });

  it("reads remote", () => {
    expect(at("Remote, Worldwide")).toBe("remote");
    expect(at("Remote")).toBe("remote");
    expect(at("Austin, TX (Remote)")).toBe("remote");
    expect(at("Remote - United States")).toBe("remote");
    expect(at("Anywhere")).toBe("remote");
  });

  it("distinguishes on-site from hybrid instead of collapsing both to 'not remote'", () => {
    expect(at("Sydney, NSW (On-site)")).toBe("onsite");
    expect(at("Sydney, NSW (Onsite)")).toBe("onsite");
    expect(at("London, England, United Kingdom (Hybrid)")).toBe("hybrid");
    expect(at("Seattle, WA (Hybrid)")).toBe("hybrid");
    expect(at("Hybrid remote - Berlin")).toBe("hybrid");
  });

  it("is unknown when the line says nothing either way", () => {
    expect(at("Dublin, Ireland")).toBe("unknown");
    expect(at("London, England, United Kingdom")).toBe("unknown");
    expect(at("")).toBe("unknown");
    expect(at(undefined)).toBe("unknown");
  });
});

describe("parseAlertEmail - work arrangement per job", () => {
  const jobs = parseAlertEmail(fixture("trapped-titles.html"));

  it("reports remote, on-site/hybrid and unstated distinctly", () => {
    expect(jobs.map((j) => [j.location, j.arrangement])).toEqual([
      ["Remote - United States", "remote"],
      ["Sydney, NSW (On-site)", "onsite"],
      ["Seattle, WA (Hybrid)", "hybrid"],
      ["Dublin, Ireland", "unknown"],
      ["Remote, Worldwide", "remote"],
      ["London, England, United Kingdom (Hybrid)", "hybrid"],
    ]);
  });

  it("never hardcodes remote for the whole source", () => {
    // The old bug: every LinkedIn alert job claimed to be remote.
    expect(jobs.every((j) => j.arrangement === "remote")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 3: badges between the title and the company shifted every field by one,
// so company came back as "Promoted" and location as the company name. This
// is the failure mode that looks plausible in the dashboard and is therefore
// the one nobody would catch by reading it.
// ---------------------------------------------------------------------------
describe("parseAlertEmail - badge lines between title and company", () => {
  const jobs = parseAlertEmail(fixture("badge-lines.html"));

  it("skips badges and still finds the real company and location", () => {
    expect(jobs[0]).toEqual({
      id: "3812345678",
      title: "Senior Full Stack Engineer",
      company: "Vercel",
      location: "Remote, Worldwide",
      arrangement: "remote",
      // Card 1's badges include "Easy Apply".
      easyApply: true,
    });
  });

  it("does not report a badge as the employer", () => {
    for (const job of jobs) {
      expect(job.company).not.toBe("Promoted");
      expect(job.company).not.toBe("Easy Apply");
      expect(job.company).not.toBe("Actively recruiting");
      expect(job.location).not.toBe("Vercel");
    }
  });

  it("prefers Unknown over a confidently wrong company", () => {
    // Card 2's first line after the title is a combined metadata line that no
    // badge pattern matches exactly. Rather than storing it as the employer,
    // the parser gives up on the positional read for that card.
    expect(jobs[1].title).toBe("Staff Backend Engineer");
    expect(jobs[1].company).toBe("Unknown");
    expect(jobs[1].location).toBeUndefined();
    expect(jobs[1].arrangement).toBe("unknown");
  });

  it("exposes the badge list as an admittedly incomplete constant", () => {
    expect(BADGE_LINE_PATTERNS.length).toBeGreaterThan(5);
    const matches = (line: string) =>
      BADGE_LINE_PATTERNS.some((re) => re.test(line));
    for (const badge of [
      "Promoted",
      "Easy Apply",
      "Actively recruiting",
      "Viewed",
      "Be an early applicant",
      "Verified",
      "Alumni work here",
      "12 connections",
      "47 applicants",
      "1,204 people also viewed",
      "Reposted",
      "New",
      "2 days ago",
    ]) {
      expect(matches(badge), `expected "${badge}" to be a badge`).toBe(true);
    }
    // Company names that merely look badge-ish must not be swallowed.
    for (const company of ["New Relic", "Verified Payments Ltd", "Promoted Content Co"]) {
      expect(matches(company), `expected "${company}" to survive`).toBe(false);
    }
  });
});

describe("parseAlertEmail - deeply nested title markup", () => {
  const [job] = parseAlertEmail(fixture("nested-spans-title.html"));

  it("does not shred a title wrapped in nested spans and bold tags", () => {
    expect(job.title).toBe("Senior Software Engineer, Platform & Infrastructure");
  });

  it("still reads the fields that follow the title", () => {
    expect(job.company).toBe("Cloudflare");
    expect(job.location).toBe("Austin, TX (Remote)");
  });
});

// ---------------------------------------------------------------------------
// FIX 4 (Task 9): the real digest template nests THREE anchors per job id -
// company logo, an outer anchor whose text is the WHOLE card, and an inner
// anchor whose text is just the title. Every stored linkedin_alert row was
// corrupt because the old dedup kept the longest anchor text, which is always
// the outer whole-card string: title "became" "Web Fullstack Developer - CX
// Michelin · Pune Division (Hybrid) Actively recruiting", company stayed
// "Unknown", location was null. This fixture is a real captured alert email
// (see tests/fixtures/linkedin-alert.html and task-1-report.md) exercising
// that exact shape.
// ---------------------------------------------------------------------------
describe("parseAlertEmail against a real alert email", () => {
  const html = readFileSync("tests/fixtures/linkedin-alert.html", "utf8");
  const jobs = parseAlertEmail(html);

  it("finds several jobs", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it("never returns a title containing the separator or a badge", () => {
    // The exact failure in production: the whole card became the title.
    for (const job of jobs) {
      expect(job.title).not.toContain("·");
      expect(job.title).not.toMatch(/easy apply|actively recruiting|applied on/i);
      expect(job.title.length).toBeLessThan(120);
    }
  });

  it("resolves a real company for most cards", () => {
    const known = jobs.filter((j) => j.company !== "Unknown");
    expect(known.length).toBeGreaterThan(jobs.length / 2);
  });

  it("classifies every card's arrangement", () => {
    for (const job of jobs) {
      expect(["remote", "hybrid", "onsite", "unknown"]).toContain(job.arrangement);
    }
  });
});
