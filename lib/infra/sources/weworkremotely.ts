import Parser from "rss-parser";
import { RawJob, RawLead, extractApplyEmail } from "./types";

// ---------------------------------------------------------------------------
// We Work Remotely publishes public per-category RSS feeds - no key required.
//
// Two things changed under us and are worth recording:
//
// 1. THE CONTRACT FEED IS GONE. `remote-contract-jobs.rss` answers 301 with an
//    empty body and no Location header, for every client. It is not a redirect
//    to follow, it is a retired category. Contract leads now come from the
//    `<type>` element on ordinary category items, which is the publisher's own
//    classification and strictly better than the keyword guessing we would
//    otherwise have fallen back to.
//
// 2. `remote-programming-jobs.rss` still responds, but WWR no longer advertises
//    it and it carries ~25 items where the current category feeds carry ~160
//    between them. It is kept in the list because it still returns results and
//    de-duplication makes the overlap free, but the specific feeds are where
//    the coverage actually is.
// ---------------------------------------------------------------------------

type WwrFields = { type?: string; region?: string; category?: string };

const parser: Parser<unknown, WwrFields> = new Parser({
  customFields: {
    // rss-parser drops unknown elements unless they are declared here, which is
    // why `type` was previously invisible and contract jobs undetectable.
    item: ["type", "region", "category"],
  },
});

const FEEDS = [
  "remote-full-stack-programming-jobs",
  "remote-front-end-programming-jobs",
  "remote-back-end-programming-jobs",
  // Deprecated but still populated; deduplicated against the above.
  "remote-programming-jobs",
];

const feedUrl = (slug: string) =>
  `https://weworkremotely.com/categories/${slug}.rss`;

type Item = Parser.Item & WwrFields;

// Jobs and contract leads are two registry entries that read the same feeds.
// Without this they would each fetch all four, doubling the request count for
// identical data. Module scope is per serverless invocation, so it clears
// itself between runs; the TTL only matters for a long-lived `next dev`.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; items: Item[] } | null = null;

async function fetchAllItems(): Promise<Item[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;

  const results = await Promise.all(
    FEEDS.map(async (slug) => {
      try {
        const feed = await parser.parseURL(feedUrl(slug));
        return (feed.items || []) as Item[];
      } catch (err) {
        // One dead category must not take the others down - WWR has retired a
        // feed before and will again.
        throw new Error(
          `wwr feed ${slug}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  const byGuid = new Map<string, Item>();
  for (const item of results.flat()) {
    const key = item.guid || item.link || item.title || "";
    if (key && !byGuid.has(key)) byGuid.set(key, item);
  }

  const items = [...byGuid.values()];
  cache = { at: Date.now(), items };
  return items;
}

function splitTitle(rawTitle: string): { company: string; title: string } {
  // WWR RSS titles are typically formatted "Company: Job Title"
  const idx = rawTitle.indexOf(":");
  if (idx > -1 && idx < 60) {
    return {
      company: rawTitle.slice(0, idx).trim(),
      title: rawTitle.slice(idx + 1).trim(),
    };
  }
  return { company: "Unknown", title: rawTitle.trim() };
}

/** WWR sets this to "Contract" on contract postings and "Full-Time" otherwise. */
function isContract(item: Item): boolean {
  return (item.type || "").trim().toLowerCase() === "contract";
}

/**
 * "Asia Only", "North America Only", "Anywhere in the World". Kept as-is rather
 * than flattened to "Remote": the dedupe fingerprint buckets it, and a hard
 * regional restriction is real information the score and the reader both want.
 */
function locationOf(item: Item): string {
  const region = (item.region || "").trim();
  return region || "Remote";
}

/**
 * Parses feed XML into items. Exported so tests can exercise the whole
 * classification path against fixture XML without touching the network —
 * `parseURL` reaches for http/https directly and cannot be stubbed cleanly.
 */
export function parseFeedXml(xml: string): Promise<{ items?: Item[] }> {
  return parser.parseString(xml) as Promise<{ items?: Item[] }>;
}

/** Pure mapping, split out from the fetch so it can be tested directly. */
export function toJobs(items: Item[]): RawJob[] {
  // Contract postings are surfaced as leads instead, so a single posting never
  // becomes both a job row and a lead row.
  return items.filter((i) => !isContract(i)).map((item): RawJob => {
    const { company, title } = splitTitle(item.title || "Untitled");
    return {
      source: "wwr",
      sourceId: item.guid || item.link || title,
      title,
      company,
      url: item.link || "",
      applyEmail: extractApplyEmail(item.content || item.contentSnippet),
      location: locationOf(item),
      remote: true,
      tags: [item.category, item.type].filter(Boolean) as string[],
      description: item.content || item.contentSnippet,
      postedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    };
  });
}

export async function fetchWeWorkRemotely(): Promise<RawJob[]> {
  return toJobs(await fetchAllItems());
}

export function toLeads(items: Item[]): RawLead[] {
  return items.filter(isContract).map((item): RawLead => {
    const { company, title } = splitTitle(item.title || "Untitled");
    return {
      source: "wwr_contract",
      sourceId: item.guid || item.link || title,
      title,
      clientOrCompany: company,
      url: item.link || "",
      contactEmail: extractApplyEmail(item.content || item.contentSnippet),
      description: item.content || item.contentSnippet,
      postedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    };
  });
}

export async function fetchWeWorkRemotelyContractLeads(): Promise<RawLead[]> {
  return toLeads(await fetchAllItems());
}

/** Test-only: drop the in-run feed cache. */
export function __resetWwrCache(): void {
  cache = null;
}
