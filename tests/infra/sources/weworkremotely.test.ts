import { describe, it, expect } from "vitest";
import {
  parseFeedXml,
  toJobs,
  toLeads,
} from "@/lib/infra/sources/weworkremotely";

// Regression cover for a live breakage: WWR retired
// `remote-contract-jobs.rss` (301, empty body, no Location — for every client),
// so the contract lead source silently produced nothing. Leads now come from
// the `<type>` element on ordinary category items, which is the publisher's own
// classification rather than keyword guessing.
//
// Fixture mirrors the real feed shape, including the custom elements
// rss-parser drops unless they are declared: <type>, <region>, <category>.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>We Work Remotely: Full-Stack Programming Jobs</title>
  <item>
    <title>Toptal: Senior Full Stack Engineer</title>
    <region>Anywhere in the World</region>
    <category>Full-Stack Programming</category>
    <type>Full-Time</type>
    <description>&lt;p&gt;React, TypeScript, Node.&lt;/p&gt;</description>
    <pubDate>Wed, 12 Aug 2026 18:38:32 +0000</pubDate>
    <guid>https://weworkremotely.com/remote-jobs/toptal-senior-full-stack</guid>
    <link>https://weworkremotely.com/remote-jobs/toptal-senior-full-stack</link>
  </item>
  <item>
    <title>A.Team: Senior Independent AI Engineer</title>
    <region>Asia Only</region>
    <category>Full-Stack Programming</category>
    <type>Contract</type>
    <description>&lt;p&gt;Contract engagement. Reach us at hire@ateam.example.&lt;/p&gt;</description>
    <pubDate>Wed, 12 Aug 2026 10:00:00 +0000</pubDate>
    <guid>https://weworkremotely.com/remote-jobs/ateam-ai-engineer</guid>
    <link>https://weworkremotely.com/remote-jobs/ateam-ai-engineer</link>
  </item>
  <item>
    <title>No Colon Title Here</title>
    <region></region>
    <category>Full-Stack Programming</category>
    <type>Full-Time</type>
    <description>&lt;p&gt;Something.&lt;/p&gt;</description>
    <guid>https://weworkremotely.com/remote-jobs/no-colon</guid>
    <link>https://weworkremotely.com/remote-jobs/no-colon</link>
  </item>
</channel></rss>`;

async function items() {
  const feed = await parseFeedXml(FEED);
  return feed.items ?? [];
}

describe("custom RSS fields are actually parsed", () => {
  it("exposes type, region and category", async () => {
    // rss-parser silently drops unknown elements unless declared in
    // customFields. That is why <type> was invisible and contract postings
    // were undetectable — the bug this whole fix exists for.
    const [first] = await items();
    expect(first.type).toBe("Full-Time");
    expect(first.region).toBe("Anywhere in the World");
    expect(first.category).toBe("Full-Stack Programming");
  });
});

describe("contract postings become leads, not jobs", () => {
  it("routes Contract items to leads only", async () => {
    const all = await items();
    const jobs = toJobs(all);
    const leads = toLeads(all);

    expect(leads).toHaveLength(1);
    expect(leads[0].title).toBe("Senior Independent AI Engineer");
    expect(leads[0].clientOrCompany).toBe("A.Team");

    // The same posting must never be both — that would be one real vacancy
    // occupying a row in two different tables.
    expect(jobs.some((j) => j.title.includes("Independent AI Engineer"))).toBe(
      false
    );
  });

  it("routes Full-Time items to jobs only", async () => {
    const all = await items();
    expect(toJobs(all)).toHaveLength(2);
    expect(toLeads(all).some((l) => l.title.includes("Full Stack"))).toBe(false);
  });

  it("matches the type case-insensitively", async () => {
    const feed = await parseFeedXml(FEED.replace("<type>Contract</type>", "<type>  contract </type>"));
    expect(toLeads(feed.items ?? [])).toHaveLength(1);
  });

  it("treats a missing type as a job rather than dropping the posting", async () => {
    // Losing a real vacancy is worse than mis-filing one, so absent type must
    // fall through to the job path.
    const feed = await parseFeedXml(FEED.replace("<type>Full-Time</type>", ""));
    expect(toJobs(feed.items ?? []).length).toBeGreaterThan(0);
  });
});

describe("field mapping", () => {
  it("splits 'Company: Title' and keeps the region as location", async () => {
    const [job] = toJobs(await items());
    expect(job.company).toBe("Toptal");
    expect(job.title).toBe("Senior Full Stack Engineer");
    // Region is real information a hard-coded "Remote" would have thrown away,
    // and the dedupe fingerprint buckets it.
    expect(job.location).toBe("Anywhere in the World");
  });

  it("falls back to Remote when the region is empty", async () => {
    const job = toJobs(await items()).find((j) => j.title === "No Colon Title Here");
    expect(job?.location).toBe("Remote");
    expect(job?.company).toBe("Unknown");
  });

  it("extracts a published contact email for leads", async () => {
    const [lead] = toLeads(await items());
    expect(lead.contactEmail).toBe("hire@ateam.example");
  });

  it("uses guid as the dedupe key", async () => {
    const jobs = toJobs(await items());
    expect(jobs[0].sourceId).toBe(
      "https://weworkremotely.com/remote-jobs/toptal-senior-full-stack"
    );
  });

  it("keeps the persisted source names unchanged", async () => {
    // These are half the dedupe key and are already in the database.
    const all = await items();
    expect(toJobs(all)[0].source).toBe("wwr");
    expect(toLeads(all)[0].source).toBe("wwr_contract");
  });
});
