import Parser from "rss-parser";
import { RawLead } from "./types";

// EXPERIMENTAL / UNVERIFIED: Upwork has historically published RSS search
// feeds at this URL shape, but this sandbox's network egress rules block
// upwork.com so this could not be test-fetched while building. Upwork has
// also tightened RSS access before without notice. Disabled by default -
// set ENABLE_UPWORK_RSS=1 in your env once you've confirmed the feed still
// loads (paste the URL in a browser first) and verified the item shape
// still matches what's parsed below.
//
// That flag is enforced by the registry (registry.ts), not in here: the old
// in-fetcher `return []` made a disabled source look identical to a source
// that ran and found nothing.
const SEARCH_TERMS = ["react developer", "next.js", "flutter developer", "ai agent developer"];

const parser = new Parser();

export async function fetchUpworkLeads(): Promise<RawLead[]> {
  const out: RawLead[] = [];
  for (const term of SEARCH_TERMS) {
    const url = `https://www.upwork.com/ab/feed/jobs/rss?q=${encodeURIComponent(
      term
    )}&sort=recency`;
    const feed = await parser.parseURL(url);
    for (const item of feed.items || []) {
      out.push({
        source: "upwork_rss",
        sourceId: item.guid || item.link || item.title || term,
        title: item.title || "Untitled",
        clientOrCompany: undefined, // Upwork RSS doesn't publish client identity pre-application
        url: item.link || "",
        description: item.content || item.contentSnippet,
        postedAt: item.pubDate ? new Date(item.pubDate) : undefined,
      });
    }
  }
  return out;
}
