import Parser from "rss-parser";
import { RawJob, RawLead, extractApplyEmail } from "./types";

const parser = new Parser();

// We Work Remotely publishes public RSS feeds per category - no key
// required. Programming is the primary category for this stack; the
// "gigs"/contract feed doubles as a freelance lead source.
const PROGRAMMING_FEED =
  "https://weworkremotely.com/categories/remote-programming-jobs.rss";
const CONTRACT_FEED = "https://weworkremotely.com/categories/remote-contract-jobs.rss";

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

export async function fetchWeWorkRemotely(): Promise<RawJob[]> {
  const feed = await parser.parseURL(PROGRAMMING_FEED);
  return (feed.items || []).map((item): RawJob => {
    const { company, title } = splitTitle(item.title || "Untitled");
    return {
      source: "wwr",
      sourceId: item.guid || item.link || title,
      title,
      company,
      url: item.link || "",
      applyEmail: extractApplyEmail(item.content || item.contentSnippet),
      location: "Remote",
      remote: true,
      description: item.content || item.contentSnippet,
      postedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    };
  });
}

export async function fetchWeWorkRemotelyContractLeads(): Promise<RawLead[]> {
  const feed = await parser.parseURL(CONTRACT_FEED);
  return (feed.items || []).map((item): RawLead => {
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
