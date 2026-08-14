import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeCompany,
  normalizeTitle,
  locationBucket,
  fingerprintJob,
  fingerprintLead,
  pickRicherDescription,
} from "@/lib/domain/dedupe/fingerprint";

// The fingerprint is a cross-source identity key that gets persisted and
// compared against rows written on earlier days. Two kinds of failure matter,
// and they are not symmetric:
//
//   - a MISSED merge costs one duplicate row, one duplicate score, one
//     duplicate cover letter. Annoying, visible, recoverable.
//   - a FALSE merge silently discards a real job that will never be seen
//     again. Unrecoverable, and invisible in the dashboard.
//
// So the negative cases below carry more weight than the positive ones, and
// every positive case is written as a pair of records shaped the way the two
// real sources actually shape them.

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("normalizeCompany", () => {
  it("collapses legal suffixes, punctuation and articles onto one token", () => {
    expect(normalizeCompany("Acme Corp., Inc.")).toBe("acme");
    expect(normalizeCompany("acme corp")).toBe("acme");
    expect(normalizeCompany("The Acme Corporation")).toBe("acme");
    expect(normalizeCompany("ACME, LLC")).toBe("acme");
    expect(normalizeCompany("Acme Ltd")).toBe("acme");
    expect(normalizeCompany("Acme Limited")).toBe("acme");
    expect(normalizeCompany("Acme GmbH")).toBe("acme");
    expect(normalizeCompany("Acme B.V.")).toBe("acme");
    expect(normalizeCompany("Acme Pty Ltd")).toBe("acme");
    expect(normalizeCompany("Acme Pte. Ltd.")).toBe("acme");
    expect(normalizeCompany("Acme S.r.l.")).toBe("acme");
    expect(normalizeCompany("Acme Oy")).toBe("acme");
    expect(normalizeCompany("Acme AB")).toBe("acme");
    expect(normalizeCompany("Acme AS")).toBe("acme");
    expect(normalizeCompany("Acme PLC")).toBe("acme");
    expect(normalizeCompany("Acme SA")).toBe("acme");
    expect(normalizeCompany("Acme AG")).toBe("acme");
    expect(normalizeCompany("Acme Co.")).toBe("acme");
  });

  it("strips the '(Remote)' / '- Remote' tail some boards append", () => {
    expect(normalizeCompany("Acme (Remote)")).toBe("acme");
    expect(normalizeCompany("Acme - Remote")).toBe("acme");
    expect(normalizeCompany("Acme Inc. (Remote)")).toBe("acme");
    expect(normalizeCompany("Acme Careers")).toBe("acme");
  });

  it("folds diacritics and ampersands so spelling variants agree", () => {
    expect(normalizeCompany("Söderberg & Partners AB")).toBe(
      "soderberg and partners"
    );
    expect(normalizeCompany("Soderberg and Partners")).toBe(
      "soderberg and partners"
    );
    expect(normalizeCompany("Nørdic Nest AS")).toBe(normalizeCompany("Nordic Nest"));
    expect(normalizeCompany("Zürich Insurance")).toBe("zurich insurance");
  });

  it("drops a domain TLD so 'Booking.com' meets 'Booking'", () => {
    expect(normalizeCompany("Booking.com B.V.")).toBe("booking");
    expect(normalizeCompany("Booking")).toBe("booking");
    expect(normalizeCompany("Sentry.io")).toBe("sentry");
    expect(normalizeCompany("Character.AI")).toBe("character");
    // ...but only when it really is a TLD. A bare second word is part of the
    // name, not punctuation.
    expect(normalizeCompany("Acme Tech")).toBe("acme tech");
    expect(normalizeCompany("Cash App")).toBe("cash app");
  });

  it("keeps multi-word names intact instead of over-stripping", () => {
    expect(normalizeCompany("AB Initio")).toBe("ab initio");
    expect(normalizeCompany("General Motors")).toBe("general motors");
    // Never strips the name down to nothing.
    expect(normalizeCompany("Inc")).toBe("inc");
    expect(normalizeCompany("Ltd.")).toBe("ltd");
  });

  it("returns an empty string for an empty name", () => {
    expect(normalizeCompany("")).toBe("");
    expect(normalizeCompany("   ")).toBe("");
  });
});

describe("normalizeTitle", () => {
  it("removes board decorations that are not part of the role", () => {
    expect(normalizeTitle("Senior Engineer (Remote)")).toBe("senior engineer");
    expect(normalizeTitle("[Hiring] Senior Engineer")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer - Remote")).toBe("senior engineer");
    expect(normalizeTitle("Urgent: Senior Engineer")).toBe("senior engineer");
    expect(normalizeTitle("🚀 Senior Engineer")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer (m/f/d)")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer (m/w/d)")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer m/w/d")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer (Full-time)")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer (Contract)")).toBe("senior engineer");
    expect(normalizeTitle("Senior Engineer, Remote (US)")).toBe("senior engineer");
    expect(normalizeTitle("Remote Senior Engineer")).toBe("senior engineer");
    expect(
      normalizeTitle("🚀 Urgent: Senior React.js Engineer (Full-time) [Hiring]")
    ).toBe("senior react engineer");
  });

  it("unifies seniority and technology spellings", () => {
    expect(normalizeTitle("Sr. Engineer")).toBe("senior engineer");
    expect(normalizeTitle("Jr Engineer")).toBe("junior engineer");
    expect(normalizeTitle("Front-End Engineer")).toBe("frontend engineer");
    expect(normalizeTitle("Front End Engineer")).toBe("frontend engineer");
    expect(normalizeTitle("Frontend Engineer")).toBe("frontend engineer");
    expect(normalizeTitle("Back End Engineer")).toBe("backend engineer");
    expect(normalizeTitle("Full Stack Engineer")).toBe("fullstack engineer");
    expect(normalizeTitle("Full-Stack Engineer")).toBe("fullstack engineer");
    expect(normalizeTitle("Node.js Developer")).toBe("nodejs developer");
    expect(normalizeTitle("Node JS Developer")).toBe("nodejs developer");
    expect(normalizeTitle("React.js Engineer")).toBe("react engineer");
    expect(normalizeTitle("ReactJS Engineer")).toBe("react engineer");
  });

  it("keeps 'engineer' and 'developer' apart - they are different words", () => {
    expect(normalizeTitle("Backend Engineer")).not.toBe(
      normalizeTitle("Backend Developer")
    );
  });

  it("does not strip employment-type words that carry meaning in-line", () => {
    // "(Contract)" as a parenthetical is decoration; "Contract Manager" is a
    // role. The segment rule keeps the two apart.
    expect(normalizeTitle("Contract Manager")).toBe("contract manager");
    expect(normalizeTitle("Full Stack Engineer")).not.toBe("stack engineer");
  });

  it("never returns an empty string for an all-decoration title", () => {
    expect(normalizeTitle("Remote")).toBe("remote");
    expect(normalizeTitle("Remote Work")).toBe("remote work");
    expect(normalizeTitle("")).toBe("");
  });
});

describe("locationBucket", () => {
  it("collapses every flavour of remote into one bucket", () => {
    expect(locationBucket("Remote, Worldwide")).toBe("remote");
    expect(locationBucket("Remote (US)")).toBe("remote");
    expect(locationBucket("Anywhere")).toBe("remote");
    expect(locationBucket("Worldwide")).toBe("remote");
    expect(locationBucket("Remote - EMEA")).toBe("remote");
    expect(locationBucket("Distributed / Global")).toBe("remote");
    expect(locationBucket("Work From Home")).toBe("remote");
  });

  it("honours the explicit remote flag over the location text", () => {
    // Adzuna sets remote:true and still ships the employer's office city.
    // Trusting the text there would split the same remote job per board.
    expect(locationBucket("London, UK", true)).toBe("remote");
    expect(locationBucket(undefined, true)).toBe("remote");
    expect(locationBucket("", true)).toBe("remote");
  });

  it("treats an unknown remote status the same as a known-remote one", () => {
    // `remote` is tri-state. Adzuna's is now an honest `undefined` rather than
    // a hardcoded flag, and a LinkedIn alert whose location line names no
    // arrangement is `undefined` too - bucketing either by the office city
    // text would fragment the same remote job across boards exactly as
    // trusting the text over an explicit `true` would. So `undefined` and
    // `true` must bucket identically.
    expect(locationBucket("London, UK", undefined)).toBe(
      locationBucket("London, UK", true)
    );
    expect(locationBucket("London, UK")).toBe("remote");
    expect(locationBucket("London, UK", undefined)).toBe("remote");
  });

  it("still buckets an explicitly non-remote job by its location", () => {
    // Only a positively-known on-site/hybrid job - remote === false - falls
    // through to the location text below.
    expect(locationBucket("London, UK", false)).toBe("uk");
  });

  it("buckets on-site locations at country granularity", () => {
    // remote:false throughout - only a positively-known non-remote job
    // reaches the location-text bucketing this test is exercising.
    expect(locationBucket("London, UK", false)).toBe("uk");
    expect(locationBucket("London", false)).toBe("uk");
    expect(locationBucket("Berlin, Germany", false)).toBe("de");
    expect(locationBucket("Berlin", false)).toBe("de");
    expect(locationBucket("Bengaluru, India", false)).toBe("in");
    expect(locationBucket("Bangalore", false)).toBe("in");
    expect(locationBucket("Toronto, ON, Canada", false)).toBe("ca");
    // Deliberately coarse: two US cities share a bucket rather than splitting
    // one job across boards that write the same place differently.
    expect(locationBucket("San Francisco, CA", false)).toBe("us");
    expect(locationBucket("New York, NY", false)).toBe("us");
    expect(locationBucket("New York, United States", false)).toBe("us");
    // State abbreviations outrank the city table, which is what keeps
    // Cambridge MA on the US side of the fence.
    expect(locationBucket("Cambridge, MA", false)).toBe("us");
  });

  it("sees through the qualifiers boards wrap around a place name", () => {
    // remote:false - see the note on the previous test.
    expect(locationBucket("USA Only", false)).toBe("us");
    expect(locationBucket("UK Only", false)).toBe("uk");
    expect(locationBucket("Europe Only", false)).toBe("eu");
    expect(locationBucket("Greater London Area", false)).toBe("uk");
    expect(locationBucket("Bay Area", false)).toBe("us");
    expect(locationBucket("Berlin or Munich", false)).toBe("de");
    expect(locationBucket("USA Only", false)).toBe(
      locationBucket("United States", false)
    );
  });

  it("returns 'unknown' when there is nothing to bucket on", () => {
    // remote:false - an unknown-remote job with nothing to go on buckets
    // "remote" (see "treats an unknown remote status..." above), so this
    // "nothing in the text either" case is only reachable once remote is
    // positively known to be false.
    expect(locationBucket(undefined, false)).toBe("unknown");
    expect(locationBucket("", false)).toBe("unknown");
    expect(locationBucket("   ", false)).toBe("unknown");
    expect(locationBucket("-", false)).toBe("unknown");
    expect(locationBucket("Multiple locations", false)).toBe("unknown");
    expect(locationBucket("N/A", false)).toBe("unknown");
  });

  it("falls back to a stable token for places it does not know", () => {
    expect(locationBucket("Reykjavik", false)).toBe("reykjavik");
    expect(locationBucket("Reykjavik", false)).toBe(
      locationBucket("reykjavik", false)
    );
  });

  it("does not merge two genuinely different countries", () => {
    expect(locationBucket("Berlin, Germany", false)).not.toBe(
      locationBucket("New York, NY", false)
    );
  });
});

describe("fingerprintJob - the same job from two boards", () => {
  it("matches RemoteOK against Himalayas for one full-stack listing", () => {
    const remoteok = fingerprintJob({
      title: "Senior Full-Stack Engineer (Remote)",
      company: "Acme Inc.",
      location: "Remote",
      remote: true,
    });
    const himalayas = fingerprintJob({
      title: "Sr. Full Stack Engineer",
      company: "Acme",
      location: "Remote, Worldwide",
    });
    expect(remoteok).toBe(himalayas);
    expect(remoteok).toBe("acme|senior fullstack engineer|remote");
  });

  it("matches WeWorkRemotely against Remotive for one frontend listing", () => {
    // WWR splits "Acme: Senior Frontend Engineer" out of the RSS title.
    const wwr = fingerprintJob({
      title: "Senior Frontend Engineer",
      company: "Acme",
      location: "Remote",
      remote: true,
    });
    const remotive = fingerprintJob({
      title: "Sr. Front-End Engineer (Remote)",
      company: "Acme, Inc.",
      location: "Worldwide",
      remote: true,
    });
    expect(wwr).toBe(remotive);
  });

  it("matches a LinkedIn alert against Arbeitnow for one node listing", () => {
    const linkedinAlert = fingerprintJob({
      title: "Senior Node.js Developer",
      company: "Acme GmbH",
      location: "Remote, Worldwide",
      remote: true,
    });
    const arbeitnow = fingerprintJob({
      title: "Senior Node JS Developer (m/w/d)",
      company: "Acme GmbH",
      location: "Berlin",
      remote: true,
    });
    expect(linkedinAlert).toBe(arbeitnow);
    expect(linkedinAlert).toBe("acme|senior nodejs developer|remote");
  });

  it("matches Adzuna against Jobicy for one backend listing", () => {
    const adzuna = fingerprintJob({
      title: "Backend Engineer - Remote",
      company: "Acme Corporation",
      location: "London, UK",
      remote: true,
    });
    const jobicy = fingerprintJob({
      title: "🚀 Backend Engineer",
      company: "The Acme Corporation",
      location: "Anywhere",
      remote: true,
    });
    expect(adzuna).toBe(jobicy);
  });

  it("matches RemoteOK against a real Adzuna listing whose remote is honestly undefined", () => {
    // Adzuna no longer hardcodes remote:true - it passes undefined when it
    // genuinely does not know. Without the tri-state guard, "London, UK"
    // would bucket by country text ("gb") instead of merging with the same
    // vacancy from a source that flags it remote, producing a duplicate row,
    // score and cover letter for one job.
    const remoteok = fingerprintJob({
      title: "Backend Engineer",
      company: "Acme",
      location: "Remote",
      remote: true,
    });
    const adzuna = fingerprintJob({
      title: "Backend Engineer",
      company: "Acme",
      location: "London, UK",
      remote: undefined,
    });
    expect(adzuna).toBe(remoteok);
  });

  it("matches across gender tags, employment type and urgency noise", () => {
    const a = fingerprintJob({
      title: "Urgent: Senior React Engineer (Full-time) (m/w/d)",
      company: "Acme Technologies GmbH",
      location: "Remote (Europe)",
      remote: true,
    });
    const b = fingerprintJob({
      title: "Sr. React Engineer",
      company: "Acme Technologies",
      location: "Anywhere",
      remote: true,
    });
    expect(a).toBe(b);
  });

  it("matches two on-site postings written with different location detail", () => {
    const a = fingerprintJob({
      title: "Backend Engineer",
      company: "Acme",
      location: "Berlin",
      remote: false,
    });
    const b = fingerprintJob({
      title: "Backend Engineer",
      company: "Acme",
      location: "Berlin, Germany",
      remote: false,
    });
    expect(a).toBe(b);
    expect(a).toBe("acme|backend engineer|de");
  });
});

describe("fingerprintJob - jobs that must NOT collide", () => {
  const base = { location: "Remote", remote: true } as const;

  it("keeps different companies apart", () => {
    expect(
      fingerprintJob({ ...base, title: "Backend Engineer", company: "Acme Inc." })
    ).not.toBe(
      fingerprintJob({ ...base, title: "Backend Engineer", company: "Globex Inc." })
    );
  });

  it("keeps different disciplines at the same company apart", () => {
    const frontend = fingerprintJob({
      ...base,
      title: "Frontend Engineer",
      company: "Acme",
    });
    const backend = fingerprintJob({
      ...base,
      title: "Backend Engineer",
      company: "Acme",
    });
    const fullstack = fingerprintJob({
      ...base,
      title: "Full Stack Engineer",
      company: "Acme",
    });
    expect(new Set([frontend, backend, fullstack]).size).toBe(3);
  });

  it("keeps seniority levels apart", () => {
    const senior = fingerprintJob({
      ...base,
      title: "Senior Backend Engineer",
      company: "Acme",
    });
    const junior = fingerprintJob({
      ...base,
      title: "Junior Backend Engineer",
      company: "Acme",
    });
    const plain = fingerprintJob({
      ...base,
      title: "Backend Engineer",
      company: "Acme",
    });
    const staff = fingerprintJob({
      ...base,
      title: "Staff Backend Engineer",
      company: "Acme",
    });
    expect(new Set([senior, junior, plain, staff]).size).toBe(4);
    // ...including when the two boards abbreviate differently.
    expect(
      fingerprintJob({ ...base, title: "Sr. Backend Engineer", company: "Acme" })
    ).not.toBe(
      fingerprintJob({ ...base, title: "Jr. Backend Engineer", company: "Acme" })
    );
  });

  it("keeps 'engineer' and 'developer' roles apart", () => {
    expect(
      fingerprintJob({ ...base, title: "Backend Engineer", company: "Acme" })
    ).not.toBe(
      fingerprintJob({ ...base, title: "Backend Developer", company: "Acme" })
    );
  });

  it("keeps distinct specialisations and levels apart", () => {
    const titles = [
      "React Native Engineer",
      "React Engineer",
      "Engineering Manager",
      "Backend Engineer II",
      "Backend Engineer III",
      "Data Engineer",
      "DevOps Engineer",
    ];
    const prints = titles.map((title) =>
      fingerprintJob({ ...base, title, company: "Acme" })
    );
    expect(new Set(prints).size).toBe(titles.length);
  });

  it("keeps similarly named but different companies apart", () => {
    const acme = fingerprintJob({ ...base, title: "Backend Engineer", company: "Acme" });
    const acmeLabs = fingerprintJob({
      ...base,
      title: "Backend Engineer",
      company: "Acme Labs",
    });
    // A deliberate under-merge: "Labs"/"Technologies"/"Group" are part of the
    // name often enough that stripping them would risk a false merge.
    expect(acme).not.toBe(acmeLabs);
  });

  it("keeps on-site postings in different countries apart", () => {
    expect(
      fingerprintJob({
        title: "Backend Engineer",
        company: "Acme",
        location: "Berlin, Germany",
        remote: false,
      })
    ).not.toBe(
      fingerprintJob({
        title: "Backend Engineer",
        company: "Acme",
        location: "New York, NY",
        remote: false,
      })
    );
  });

  it("does not treat a placeholder company as a real name", () => {
    // WeWorkRemotely and Himalayas both emit "Unknown" when their parse misses.
    const unknownA = fingerprintJob({
      ...base,
      title: "Backend Engineer",
      company: "Unknown",
    });
    const unknownB = fingerprintJob({
      ...base,
      title: "Data Engineer",
      company: "Unknown",
    });
    const real = fingerprintJob({
      ...base,
      title: "Backend Engineer",
      company: "Acme",
    });
    expect(unknownA).not.toBe(unknownB);
    expect(unknownA).not.toBe(real);
    expect(unknownA.startsWith("anon|")).toBe(true);
  });
});

describe("fingerprintJob - stability", () => {
  const job = {
    title: "Senior Full-Stack Engineer (Remote)",
    company: "Acme Inc.",
    location: "Remote, Worldwide",
    remote: true,
  };

  it("returns an identical string for the same input", () => {
    const first = fingerprintJob(job);
    expect(fingerprintJob(job)).toBe(first);
    expect(fingerprintJob({ ...job })).toBe(first);
    expect([1, 2, 3, 4, 5].map(() => fingerprintJob(job))).toEqual(
      new Array(5).fill(first)
    );
  });

  it("does not depend on the clock or on randomness", () => {
    const before = fingerprintJob(job);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-12-25T03:14:15.926Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.42);

    expect(fingerprintJob(job)).toBe(before);
    expect(fingerprintLead({ title: "React Developer", clientOrCompany: "Acme" })).toBe(
      "acme|react developer|lead"
    );
  });

  it("keeps the persisted shape readable: company|title|bucket", () => {
    expect(fingerprintJob(job)).toBe("acme|senior fullstack engineer|remote");
    expect(fingerprintJob(job).split("|")).toHaveLength(3);
  });

  it("still produces a key when the source gave us almost nothing", () => {
    // remote:false - an unspecified remote status buckets "remote" even with
    // no location text (see "treats an unknown remote status..." above), so
    // reaching "unknown" here needs the same positively-known-false as any
    // other on-site case.
    expect(fingerprintJob({ title: "", company: "", remote: false })).toBe(
      "anon|untitled|unknown"
    );
  });
});

describe("fingerprintLead", () => {
  it("merges the same named lead written two ways", () => {
    expect(
      fingerprintLead({
        title: "React Developer (Remote)",
        clientOrCompany: "Acme Inc.",
      })
    ).toBe(fingerprintLead({ title: "React Developer", clientOrCompany: "Acme" }));
  });

  it("does not collapse anonymous leads onto one key", () => {
    const leads = [
      "Need a React developer for a 3-month dashboard build",
      "Looking for a Next.js developer to finish an ecommerce site",
      "WordPress to Next.js migration, ongoing work",
      "Build a Slack bot with the Anthropic API",
    ].map((title) => fingerprintLead({ title }));

    expect(new Set(leads).size).toBe(leads.length);
    for (const lead of leads) expect(lead.startsWith("anon|")).toBe(true);
  });

  it("treats a placeholder client the same as a missing one", () => {
    expect(
      fingerprintLead({ title: "React Developer", clientOrCompany: "Confidential" })
    ).toBe(fingerprintLead({ title: "React Developer" }));
    expect(
      fingerprintLead({ title: "React Developer", clientOrCompany: "Unknown" })
    ).toBe(fingerprintLead({ title: "React Developer", clientOrCompany: "" }));
  });

  it("keeps a named client apart from an anonymous one", () => {
    expect(
      fingerprintLead({ title: "React Developer", clientOrCompany: "Acme" })
    ).not.toBe(fingerprintLead({ title: "React Developer" }));
  });

  it("keeps the full title for anonymous leads, since it is the only identity", () => {
    // For a nameless lead nothing distinguishing may be stripped, so the
    // decorated and undecorated titles stay separate keys here even though
    // fingerprintJob would merge them.
    expect(fingerprintLead({ title: "Urgent: React dev (Remote)" })).not.toBe(
      fingerprintLead({ title: "React dev" })
    );
    expect(fingerprintLead({ title: "Urgent: React dev (Remote)" })).toBe(
      "anon|urgent react dev remote|lead"
    );
  });

  it("never collides with a job fingerprint", () => {
    expect(
      fingerprintLead({ title: "Backend Engineer", clientOrCompany: "Acme" })
    ).not.toBe(
      fingerprintJob({
        title: "Backend Engineer",
        company: "Acme",
        location: "Remote",
        remote: true,
      })
    );
  });

  it("is deterministic", () => {
    const lead = { title: "Need a Next.js developer", clientOrCompany: "Acme LLC" };
    const first = fingerprintLead(lead);
    expect(fingerprintLead(lead)).toBe(first);
    expect(fingerprintLead({ ...lead })).toBe(first);
  });
});

describe("pickRicherDescription", () => {
  const realContent =
    "We are looking for a senior full-stack engineer to own our Next.js " +
    "dashboard end to end. You will work with TypeScript, Drizzle and " +
    "SQLite, ship to Vercel, and pair with two other engineers on the " +
    "ingestion pipeline. Experience with background workers is a plus.";

  const htmlBoilerplate =
    '<div class="job-description-wrapper" id="jd">' +
    "<style>.jd{color:#333;font-family:Helvetica,Arial,sans-serif}</style>" +
    "<p>&nbsp;</p><p>&nbsp;</p>" +
    '<p><a href="https://boards.example.com/track?utm_source=aggregator&utm_medium=feed&utm_campaign=jobs">Apply now</a></p>' +
    "<ul><li>&nbsp;</li><li>&nbsp;</li><li>&nbsp;</li></ul>" +
    "<p>We are an equal opportunity employer and value diversity at our " +
    "company. All qualified applicants will receive consideration for " +
    "employment without regard to race, religion, gender or age. " +
    "Privacy policy. Cookie policy. All rights reserved.</p>" +
    '<p><a href="https://boards.example.com/share">Share this job</a></p></div>';

  it("prefers real content over longer boilerplate", () => {
    // The trap this guards against: the noisy string really is longer.
    expect(htmlBoilerplate.length).toBeGreaterThan(realContent.length);
    expect(pickRicherDescription(htmlBoilerplate, realContent)).toBe(realContent);
    expect(pickRicherDescription(realContent, htmlBoilerplate)).toBe(realContent);
  });

  it("prefers the longer description when both are real content", () => {
    const short = "Senior full-stack engineer wanted.";
    expect(pickRicherDescription(short, realContent)).toBe(realContent);
    expect(pickRicherDescription(realContent, short)).toBe(realContent);
  });

  it("returns the original string, markup and all", () => {
    const wrapped = `<div><p>${realContent}</p><p>${realContent}</p></div>`;
    expect(pickRicherDescription(wrapped, realContent)).toBe(wrapped);
  });

  it("handles missing sides", () => {
    expect(pickRicherDescription(undefined, realContent)).toBe(realContent);
    expect(pickRicherDescription(realContent, undefined)).toBe(realContent);
    expect(pickRicherDescription(undefined, undefined)).toBeUndefined();
    expect(pickRicherDescription("", undefined)).toBeUndefined();
    expect(pickRicherDescription("   ", "")).toBeUndefined();
  });

  it("keeps an empty-but-present markup string over nothing at all", () => {
    expect(pickRicherDescription("<p>&nbsp;</p>", undefined)).toBe("<p>&nbsp;</p>");
  });

  it("breaks ties toward the first argument so merges are order-stable", () => {
    const a = "Alpha description of the very same length.";
    const b = "Bravo description of the very same length.";
    expect(pickRicherDescription(a, b)).toBe(a);
    expect(pickRicherDescription(b, a)).toBe(b);
  });

  it("is deterministic", () => {
    const first = pickRicherDescription(htmlBoilerplate, realContent);
    expect(pickRicherDescription(htmlBoilerplate, realContent)).toBe(first);
  });
});
