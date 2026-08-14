import * as cheerio from "cheerio";
import { deriveArrangement } from "@/lib/domain/facts";
import type { ParsedAlertJob } from "./types";

// ---------------------------------------------------------------------------
// Indeed "Apply to jobs at ..." digests.
//
// Two nested anchors per job share one `jk=` job key: a whole-card anchor and a
// title-only anchor. The card's enclosing container splits into lines like:
//
//   "MERN Stack Developer" / "Wits Innovation Lab" / "Mumbai, Maharashtra"
//   / "Easily apply" / "<description snippet>" / "Just posted"
//
// FIELDS AFTER COMPANY ARE NOT AT FIXED INDEXES. A company with a star rating
// inserts a bare "3.5" line after the company, shifting location, salary and
// everything after it down by one. Reading by index would store the rating as
// the location — the same defect that once made the LinkedIn parser store
// "Promoted" as a company name. Every field from location onward is therefore
// identified by SHAPE, not position.
//
// title and company themselves are the one KNOWN EXCEPTION: they are read
// positionally, as ls[0] and ls[1], guarded only against a bare numeric
// rating landing in either slot (see RATING_RE below). This holds for all 19
// cards in the captured fixture — every one starts with title then company,
// no exceptions observed. It would NOT hold against a textual badge preceding
// the title (a hypothetical "Sponsored" or "New" label): nothing here detects
// that shape, so such a badge would silently become the stored title, the
// real title would become the company, and every field after it would
// cascade — with no error and no skip. Not guarded against because no card in
// the fixture exhibits it; add a guard if one ever does.
// ---------------------------------------------------------------------------

const JK_RE = /[?&]jk=([a-f0-9]+)/i;

type DomNode = { type: string; name?: string; data?: string; children?: DomNode[] };

function lines(el: DomNode): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  const walk = (n: DomNode) => {
    if (n.type === "text") return push(n.data);
    if (n.type !== "tag") return;
    for (const c of n.children || []) walk(c);
  };
  walk(el);
  return out;
}

/** A bare star rating: "3.5", "4.0". */
const RATING_RE = /^\d(?:\.\d)?$/;
/** "₹3,00,000 - ₹7,00,000 a year", "From ₹25,000 a month", "$120,000 a year". */
const SALARY_RE = /[₹$€£]\s?[\d,]/;
const EASY_APPLY_RE = /^easily apply$/i;
/** "Just posted", "2 days ago", "Active 3 days ago", "Today". */
const POSTED_RE = /^(just posted|today|yesterday|active \d+\+? days? ago|\d+\+? days? ago|hiring ongoing|posted \d+)/i;
/** A description snippet is long prose; a location is short. */
const MAX_LOCATION_LEN = 60;

export function parseIndeedAlert(html: string): ParsedAlertJob[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, ParsedAlertJob>();

  $("a[href]").each((_i, a) => {
    const href = $(a).attr("href") || "";
    const id = href.match(JK_RE)?.[1];
    if (!id || byId.has(id)) return;

    const container = $(a).closest("td, tr, table").get(0);
    if (!container) return;
    const ls = lines(container as unknown as DomNode);
    if (ls.length < 2) return;

    // Positional, not shape-based — see the KNOWN EXCEPTION note in the file
    // header above.
    const title = ls[0];
    const company = ls[1];
    if (!title || !company || RATING_RE.test(title) || RATING_RE.test(company)) return;

    let location: string | undefined;
    let salaryText: string | undefined;
    let description: string | undefined;
    let easyApply = false;

    for (const line of ls.slice(2)) {
      if (RATING_RE.test(line)) continue;            // company rating — the shifter
      if (EASY_APPLY_RE.test(line)) { easyApply = true; continue; }
      // Length before EITHER short-metadata pattern below. Both POSTED_RE and
      // SALARY_RE are anchored only at the START (or not at all), so a long
      // description that merely OPENS with "Today ..." or QUOTES a pay figure
      // ("...Pay: From ₹10,000.00 per month.") would otherwise satisfy one of
      // them and get swallowed as a bogus posted-date or salary candidate. A
      // real posted-date or salary line is always short (11 and 31 chars are
      // the longest of each seen in this fixture, both well under
      // MAX_LOCATION_LEN), so testing length first can never steal a genuine
      // match from either pattern — it only keeps a long description out of
      // their grasp.
      if (line.length > MAX_LOCATION_LEN) { description ??= line; continue; }
      if (POSTED_RE.test(line)) continue;
      if (SALARY_RE.test(line)) { salaryText ??= line; continue; }
      location ??= line;
    }

    byId.set(id, {
      id,
      title,
      company,
      location,
      // Canonical and tracking-free. The href in the email carries a per-send
      // `qd=` token that would otherwise be persisted forever.
      url: `https://in.indeed.com/viewjob?jk=${id}`,
      arrangement: deriveArrangement({ location }),
      easyApply,
      description,
      salaryText,
    });
  });

  return [...byId.values()];
}
