// lib/domain/facts/geo.ts
import type { GeoEligibility } from "./types";

// ---------------------------------------------------------------------------
// Can somebody based in India actually take this job?
//
// This is the question the system was failing to ask. Of 623 stored jobs every
// single one was marked remote, so "Remote, USA" and "Remote, Anywhere in the
// World" ranked identically — and roughly a sixth of the ranked list was roles
// the operator cannot be hired for.
//
// Remoteness and eligibility are independent (see ./arrangement.ts), so this
// module reads ONLY the geographic restriction and says nothing about where the
// work happens.
//
// INEVITABLY INCOMPLETE: this is a token list, not a geocoder. An unrecognised
// place yields `unknown` — no bonus, no penalty — rather than a guess. Adding a
// city here is cheap; guessing wrong is not.
// ---------------------------------------------------------------------------

const WORLDWIDE_RE =
  /\b(worldwide|anywhere|global(?:ly)?|international|any\s+country|no\s+location\s+restriction)\b/i;

/**
 * Indian cities that appear in LinkedIn alerts without the country name.
 *
 * A match here is unambiguous: every token names a place that exists only in
 * India. `delhi`, `hyderabad`, `kochi`, and `surat` are deliberately excluded
 * — each also names a real place outside India (Delhi, NY; Delhi, ON;
 * Hyderabad, Pakistan; Kōchi, Japan; Surat Thani, Thailand) — and are handled
 * separately by AMBIGUOUS_INDIA_RE below. `new\s+delhi` stays here because
 * that phrase is unambiguous on its own.
 */
const UNAMBIGUOUS_INDIA_RE =
  /\b(india|bengaluru|bangalore|mumbai|new\s+delhi|gurgaon|gurugram|noida|pune|chennai|kolkata|ahmedabad|mohali|chandigarh|jaipur|dehradun|indore|coimbatore|nagpur|lucknow|bhopal|vadodara|thiruvananthapuram|mysuru|mysore|jamshedpur|ranchi|kharagpur|tikamgarh|krishnagiri|wayanad|ajmer|rajkot)\b/i;

/**
 * City names that are Indian only in the absence of a competing country —
 * "Hyderabad (On-site)" is India, "Hyderabad, Pakistan" is not. Resolved by
 * namesAnotherCountry() at the call site.
 */
const AMBIGUOUS_INDIA_RE = /\b(delhi|hyderabad|kochi|surat)\b/i;

/**
 * Countries that collide with an ambiguous Indian city name above. Kept as a
 * single alternation string so OTHER_COUNTRY_ANCHORED_RE below — used to
 * decide whether a location COMPONENT is that country, not merely mentions
 * it — can never drift out of sync with this list.
 */
const OTHER_COUNTRY_TOKENS =
  "pakistan|japan|thailand|indonesia|philippines|usa?|u\\.s\\.a?\\.?|united\\s+states|america|americas|canada|uk|united\\s+kingdom|england|scotland|wales|europe|european|eu|emea|eea|latam|latin\\s+america|south\\s+america|australia|new\\s+zealand|anz";

/**
 * Anchored end to end: matches only when an entire (trimmed, parenthetical-
 * stripped) location component IS a country name, e.g. the "Pakistan" in
 * "Hyderabad, Pakistan". An unanchored match would also fire on "US" inside
 * "Hyderabad-based team serving US clients", which is incidental prose, not
 * a stated restriction — the same hazard WORLDWIDE_RE already guards against
 * for "Remote, Worldwide (US timezone overlap)".
 */
const OTHER_COUNTRY_ANCHORED_RE = new RegExp(`^(?:${OTHER_COUNTRY_TOKENS})$`, "i");

/**
 * True when `text` names another country as its own location component
 * (split on `,` `/` `;`) rather than mentioning one in passing.
 */
function namesAnotherCountry(text: string): boolean {
  return text.split(/[,/;]/).some((component) => {
    const trimmed = component
      .trim()
      .replace(/\s*\([^)]*\)?\s*$/, "")
      .trim();
    return OTHER_COUNTRY_ANCHORED_RE.test(trimmed);
  });
}

const APAC_RE = /\b(apac|asia[\s-]?pacific|asia)\b/i;

// Regions that exclude India when named as the restriction.
const RESTRICTED: { token: string; re: RegExp }[] = [
  { token: "us", re: /(?:\b(?:usa?|united\s+states|americas?)\b)|(?:\bu\.s\.a?\.?)/i },
  { token: "ca", re: /\b(canada|canadian)\b/i },
  { token: "uk", re: /\b(uk|u\.k\.|united\s+kingdom|great\s+britain|england|scotland|wales)\b/i },
  { token: "eu", re: /\b(eu|europe|european|emea|eea)\b/i },
  { token: "latam", re: /\b(latam|latin\s+america|south\s+america)\b/i },
  { token: "anz", re: /\b(australia|new\s+zealand|anz)\b/i },
];

// ISO-ish codes inside a multi-region list: "Remote (GB; DE; NL)".
const REGION_LIST_RE = /\(([^)]*[A-Z]{2}(?:\s*[;,]\s*[A-Z]{2})+[^)]*)\)/;

export type GeoFacts = { regions: string[]; eligibility: GeoEligibility };

/**
 * Precedence matters and is deliberate:
 *   1. worldwide wins outright — "Remote, Worldwide (US timezone overlap)" is
 *      unrestricted, and an incidental "US" must not downgrade it
 *   2. an explicit region list is read for IN before anything else
 *   3. India / APAC -> eligible
 *   4. a named excluding region -> restricted
 *   5. otherwise unknown
 */
export function deriveGeo(location?: string): GeoFacts {
  const text = (location ?? "").replace(/[\s,]+$/, "").trim();
  if (!text) return { regions: [], eligibility: "unknown" };

  if (WORLDWIDE_RE.test(text)) {
    return { regions: ["worldwide"], eligibility: "worldwide" };
  }

  // "Remote (GB; DE; NL)" — an explicit allow-list of countries.
  const list = text.match(REGION_LIST_RE)?.[1];
  if (list) {
    const codes = list
      .split(/[;,]/)
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z]{2}$/.test(c));
    if (codes.length) {
      return codes.includes("in")
        ? { regions: codes, eligibility: "eligible" }
        : { regions: codes, eligibility: "restricted" };
    }
  }

  const isIndia =
    UNAMBIGUOUS_INDIA_RE.test(text) ||
    (AMBIGUOUS_INDIA_RE.test(text) && !namesAnotherCountry(text));

  const regions: string[] = [];
  if (isIndia) regions.push("in");
  if (APAC_RE.test(text)) regions.push("apac");
  if (regions.length) return { regions, eligibility: "eligible" };

  for (const { token, re } of RESTRICTED) {
    if (re.test(text)) regions.push(token);
  }
  if (regions.length) return { regions, eligibility: "restricted" };

  return { regions: [], eligibility: "unknown" };
}
