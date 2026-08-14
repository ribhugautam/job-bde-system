// Cross-source identity for jobs and leads.
//
// The pipeline pulls the same real-world job from up to eleven sources
// (RemoteOK, Remotive, Arbeitnow, WeWorkRemotely, Himalayas, Jobicy, Adzuna,
// LinkedIn alert emails, Wellfound alert emails, Indeed alert emails, Y
// Combinator). Keyed on (source, sourceId) alone, one job becomes N
// rows, N scored entries and N drafted cover letters. The fingerprint below is
// the identity key that collapses them: it is what jobs.fingerprint and
// leads.fingerprint store, and what the merge step groups on.
//
// Two properties this module has to hold to:
//
//  1. PURE. No I/O, no DB, no network, no process.env - and, just as
//     important, no clock and no randomness. The fingerprint is persisted and
//     compared against rows written on other days, so the same input must map
//     to the same string forever. Every rule here is a plain table lookup or a
//     regex; nothing reads ambient state.
//
//  2. Biased toward merging on the axes where boards disagree cosmetically
//     (legal suffixes, "(Remote)" decorations, "Sr." vs "Senior", location
//     phrasing) and toward *not* merging on the axes that carry real meaning
//     (a different company, a different discipline, a different seniority).
//     A missed merge costs one duplicate row; a false merge silently discards
//     a real job. Where the two conflict, the notes on each rule say which way
//     the call went and why.

import { RawJob, RawLead } from "@/lib/domain/types";

/** Company slot used when the source gave us no usable employer name. */
const ANON = "anon";

// ---------------------------------------------------------------------------
// Shared text primitives
// ---------------------------------------------------------------------------

// Latin letters that NFKD does not decompose into "base + combining mark", so
// they survive the diacritic strip and have to be mapped by hand. Without this
// "Nørdic AS" and "Nordic" fingerprint apart.
const LETTER_FOLDS: Record<string, string> = {
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  ħ: "h",
  ŋ: "n",
};

// Combining diacritical marks, built from escapes rather than written as a
// literal range so the source file contains no invisible characters.
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** Lowercase + strip diacritics. Leaves punctuation and spacing alone. */
function foldCase(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[øßæœđðþłıħŋ]/g, (ch) => LETTER_FOLDS[ch] ?? ch);
}

/**
 * Fold, then reduce to a bare [a-z0-9] token stream.
 *
 * Dots are deleted rather than turned into spaces so that "B.V.", "Node.js"
 * and "U.S." collapse to "bv", "nodejs" and "us" instead of splitting into
 * single letters. "&" becomes "and" so "Smith & Co" and "Smith and Co" agree.
 * Everything else non-alphanumeric - including emoji, which is how "🚀" in a
 * title disappears - becomes a separator.
 */
function tokensOf(raw: string): string[] {
  return foldCase(raw)
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Lossless-ish normalization: same character folding, nothing removed. */
function normalizeText(raw: string): string {
  return tokensOf(raw).join(" ");
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

// Legal forms and their abbreviations. Stripped only from the END of the name,
// so "AB Initio" keeps its "ab" and "Corporation Service Company" keeps its
// "corporation".
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "lllc",
  "llp",
  "lp",
  "ltd",
  "ltda",
  "limited",
  "plc",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "mbh",
  "ug",
  "ag",
  "kg",
  "kgaa",
  "se",
  "bv",
  "nv",
  "cv",
  "sa",
  "sas",
  "sarl",
  "sl",
  "slu",
  "spa",
  "srl",
  "ab",
  "as",
  "asa",
  "aps",
  "oy",
  "oyj",
  "pty",
  "pte",
  "kk",
  "kft",
  "zrt",
  "doo",
  "sp",
  "z",
  "oo",
  "dmcc",
  "fzco",
  "fze",
  "pvt",
  "sdn",
  "bhd",
]);

// Board-added noise that lands in the company field: RemoteOK-style
// "Acme (Remote)", aggregator-style "Acme Careers".
const COMPANY_EDGE_NOISE = new Set([
  "remote",
  "remotely",
  "worldwide",
  "anywhere",
  "hiring",
  "careers",
  "career",
  "jobs",
  "job",
]);

// Only stripped when it follows a dot, so "Acme Tech" and "Cash App" keep
// their second word while "Acme.tech" and "cash.app" lose the TLD.
const COMPANY_TLD_RE =
  /\.(com|io|ai|net|org|so|dev|app|co|cloud|tech|xyz|gg|tv|me)\b/g;

// Values that mean "we don't know the employer". WeWorkRemotely and Himalayas
// both literally emit "Unknown" when their parse fails, so treating these as a
// real name would merge unrelated jobs under one key.
const PLACEHOLDER_COMPANIES = new Set([
  "unknown",
  "n a",
  "na",
  "none",
  "null",
  "undefined",
  "confidential",
  "undisclosed",
  "private",
  "anonymous",
  "hidden",
  "company",
  "employer",
  "client",
  ANON,
]);

/**
 * Normalizes an employer name to a cross-source-stable token.
 *
 * Lowercases, folds diacritics, drops punctuation, strips a leading "the",
 * and repeatedly strips trailing legal suffixes and board noise, so that
 * "Acme Corp., Inc.", "acme corp" and "The Acme Corporation" all land on
 * "acme". Never strips the name away to nothing - a company genuinely called
 * "Inc" keeps it.
 *
 * Deliberately does NOT strip descriptive tails like "Labs", "Technologies",
 * "Group" or "Studio": those are part of the name often enough ("Acme Labs" is
 * not "Acme") that stripping them would trade a rare missed merge for an
 * occasional false one.
 */
export function normalizeCompany(raw: string): string {
  if (!raw) return "";

  // Domain-style names: "Booking.com", "Sentry.io", "Character.AI". Dropping
  // the TLD is what lets those meet the plain "Booking"/"Sentry" spelling the
  // other board used - tokensOf would otherwise glue it on as "bookingcom".
  let tokens = tokensOf(foldCase(raw).replace(COMPANY_TLD_RE, " "));

  // Leading article: "The Acme Corporation" -> "Acme Corporation".
  while (tokens.length > 1 && tokens[0] === "the") tokens = tokens.slice(1);

  // Trailing suffixes, repeatedly: "Acme Pty Ltd" -> "Acme", and
  // "Acme Corp., Inc." -> "Acme". The length guard keeps the result non-empty.
  let stripped = true;
  while (stripped && tokens.length > 1) {
    stripped = false;
    const last = tokens[tokens.length - 1];
    if (LEGAL_SUFFIXES.has(last) || COMPANY_EDGE_NOISE.has(last)) {
      tokens = tokens.slice(0, -1);
      stripped = true;
    }
  }

  return tokens.join(" ");
}

/** True when a normalized company name carries no identifying information. */
function isPlaceholderCompany(normalized: string): boolean {
  return !normalized || PLACEHOLDER_COMPANIES.has(normalized);
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

// Words that are decoration rather than role. A bracketed group or a
// separator-delimited segment is dropped only when EVERY one of its tokens is
// in this set, which is what makes it safe to include broad words like "full",
// "time" and "contract": "(Full-time)" and " - Contract" go, while
// "Full Stack Engineer" and "Contract Manager" survive untouched.
const DECORATION_TOKENS = new Set([
  // remote / location decorations
  "remote",
  "remotely",
  "remoto",
  "worldwide",
  "world",
  "wide",
  "anywhere",
  "global",
  "globally",
  "hybrid",
  "onsite",
  "site",
  "wfh",
  "work",
  "from",
  "home",
  "based",
  "location",
  "friendly",
  "only",
  "preferred",
  "flexible",
  "timezone",
  "timezones",
  "cet",
  "est",
  "pst",
  "gmt",
  "utc",
  "us",
  "usa",
  "uk",
  "eu",
  "gb",
  "emea",
  "apac",
  "latam",
  "europe",
  "america",
  "americas",
  "canada",
  "india",
  "germany",
  // employment type
  "full",
  "part",
  "time",
  "fulltime",
  "parttime",
  "contract",
  "contracting",
  "contractor",
  "freelance",
  "permanent",
  "perm",
  "temporary",
  "temp",
  "w2",
  "c2c",
  "corp",
  "to",
  "no",
  "1099",
  // call-to-action noise
  "urgent",
  "urgently",
  "hiring",
  "immediate",
  "immediately",
  "joiner",
  "joiners",
  "apply",
  "now",
  "open",
  "opening",
  "position",
  "role",
  "vacancy",
  "any",
  "all",
  "agencies",
  // gender tags: (m/w/d), (f/m/x), "all genders"
  "m",
  "f",
  "d",
  "w",
  "x",
  "v",
  "h",
  "mfd",
  "mwd",
  "fmd",
  "mfx",
  "mwx",
  "gender",
  "genders",
  "divers",
  "diverse",
]);

// Narrower set, stripped from the first/last position of the final token list
// when there is no separator to key off: "Remote Senior Engineer",
// "Backend Engineer Remote". Employment-type words are deliberately absent
// here - dropping a bare leading "Contract" would turn "Contract Manager" into
// "Manager", a genuinely different role.
const EDGE_TOKENS = new Set([
  "remote",
  "remotely",
  "worldwide",
  "anywhere",
  "hybrid",
  "onsite",
  "wfh",
  "urgent",
  "urgently",
  "hiring",
  "fulltime",
  "parttime",
  "freelance",
]);

// Bare gender tags outside brackets: "Engineer m/w/d", "Developer (f/m/x)"
// once the brackets have been unwrapped.
const GENDER_TAG_RE = /\b[mwfdhvx](\s*[/\-–]\s*[mwfdhvx])+\b/g;

// Segment separators. Only spaced dashes count, so the hyphen inside
// "Full-Stack" is left alone.
const SEGMENT_SPLIT_RE = /\s[-–—]\s|[|,:;•·]/;

// Spelling variants that must collide, applied to the joined token string.
// Multi-word rules run first so that "full stack" is already "fullstack"
// before any single-word rule (and before the edge strip) can see a bare
// "full". "engineer" and "developer" are pointedly NOT unified: they are
// different words that boards do not use interchangeably for the same posting,
// and merging them would collapse genuinely distinct roles.
const PHRASE_RULES: [RegExp, string][] = [
  [/\bfront end\b/g, "frontend"],
  [/\bback end\b/g, "backend"],
  [/\bfull stack\b/g, "fullstack"],
  [/\bfullstack\b/g, "fullstack"],
  [/\bdev ops\b/g, "devops"],
  [/\bnode js\b/g, "nodejs"],
  [/\breact js\b/g, "react"],
  [/\breactjs\b/g, "react"],
  [/\bvue js\b/g, "vue"],
  [/\bvuejs\b/g, "vue"],
  [/\bnext js\b/g, "nextjs"],
  [/\btype script\b/g, "typescript"],
  [/\bjava script\b/g, "javascript"],
  [/\bsr\b/g, "senior"],
  [/\bsnr\b/g, "senior"],
  [/\bjr\b/g, "junior"],
  [/\bjnr\b/g, "junior"],
];

function isDecorationOnly(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => DECORATION_TOKENS.has(t));
}

/**
 * Drops bracketed decorations - "(Remote)", "[Hiring]", "(m/w/d)",
 * "(Full-time)" - and unwraps every other bracketed group so its contents
 * survive as ordinary words ("(Java)" stays).
 */
function stripBracketDecorations(text: string): string {
  return text.replace(/[([{]([^)\]}]*)[)\]}]/g, (_match, inner: string) => {
    const tokens = tokensOf(inner);
    return tokens.length && !isDecorationOnly(tokens) ? ` ${inner} ` : " ";
  });
}

function applyPhraseRules(tokens: string[]): string[] {
  let text = ` ${tokens.join(" ")} `;
  for (const [pattern, replacement] of PHRASE_RULES) {
    text = text.replace(pattern, replacement);
  }
  return text.trim().split(/\s+/).filter(Boolean);
}

function stripEdgeTokens(tokens: string[]): string[] {
  let out = tokens;
  while (out.length > 1 && EDGE_TOKENS.has(out[0])) out = out.slice(1);
  while (out.length > 1 && EDGE_TOKENS.has(out[out.length - 1])) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Normalizes a job title to the role it actually describes.
 *
 * Strips the packaging boards bolt on - "(Remote)", "[Hiring]", "Urgent:",
 * "- Remote", "(Full-time)", "(m/w/d)", emoji - and unifies spelling variants
 * ("Sr." -> senior, "Front-End" -> frontend, "Node.js" -> nodejs) so the same
 * role written two ways lands on one string.
 *
 * Word ORDER is preserved rather than sorted. Sorting would additionally merge
 * "Engineer, Frontend" with "Frontend Engineer", but it would also merge
 * unrelated permutations, and boards overwhelmingly reproduce the employer's
 * own word order - so the extra merges are not worth the extra false-merge
 * surface.
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return "";

  let text = foldCase(raw);
  text = stripBracketDecorations(text);
  text = text.replace(GENDER_TAG_RE, " ");

  // Separator-delimited decoration: "Urgent: X", "X - Remote", "X, Contract".
  const segments = text.split(SEGMENT_SPLIT_RE).map(tokensOf);
  const meaningful = segments.filter(
    (tokens) => tokens.length > 0 && !isDecorationOnly(tokens)
  );

  // A title that is nothing but decoration ("Remote") still needs a value;
  // keep its longest segment rather than returning an empty string.
  const chosen = meaningful.length
    ? meaningful
    : [
        segments.reduce<string[]>(
          (best, cur) => (cur.length > best.length ? cur : best),
          []
        ),
      ];

  const words = applyPhraseRules(chosen.flat());
  // A title that is decoration all the way down ("Remote Work") keeps what it
  // has; the edge strip would otherwise leave a misleading fragment.
  if (isDecorationOnly(words)) return words.join(" ");
  return stripEdgeTokens(words).join(" ");
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function fromList(code: string, aliases: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const alias of aliases) out[alias] = code;
  return out;
}

// Anything that reads as "not tied to an office" collapses into one bucket, so
// "Remote, Worldwide", "Remote (US)", "Anywhere" and "Distributed" agree.
const REMOTE_HINT_RE =
  /\b(remote|remotely|anywhere|worldwide|world wide|distributed|global|globally|virtual|telecommute|telework|work from home|wfh|home based|no office)\b/;

// Unambiguous country names/aliases. Two-letter ISO codes are mostly absent on
// purpose: as a bare segment "CA" means California far more often than Canada
// and "IN" means Indiana far more often than India, so those are resolved by
// the state table instead.
const COUNTRY_ALIASES: Record<string, string> = {
  ...fromList("us", [
    "usa",
    "us",
    "u s",
    "u s a",
    "united states",
    "united states of america",
  ]),
  ...fromList("uk", [
    "uk",
    "united kingdom",
    "great britain",
    "britain",
    "england",
    "scotland",
    "wales",
    "northern ireland",
  ]),
  ...fromList("ca", ["canada"]),
  ...fromList("de", ["germany", "deutschland"]),
  ...fromList("fr", ["france"]),
  ...fromList("es", ["spain", "espana"]),
  ...fromList("pt", ["portugal"]),
  ...fromList("nl", ["netherlands", "the netherlands", "holland"]),
  ...fromList("be", ["belgium"]),
  ...fromList("ch", ["switzerland"]),
  ...fromList("at", ["austria"]),
  ...fromList("it", ["italy"]),
  ...fromList("ie", ["ireland"]),
  ...fromList("pl", ["poland", "polska"]),
  ...fromList("cz", ["czechia", "czech republic"]),
  ...fromList("sk", ["slovakia"]),
  ...fromList("si", ["slovenia"]),
  ...fromList("hr", ["croatia"]),
  ...fromList("rs", ["serbia"]),
  ...fromList("ro", ["romania"]),
  ...fromList("bg", ["bulgaria"]),
  ...fromList("gr", ["greece"]),
  ...fromList("hu", ["hungary"]),
  ...fromList("ua", ["ukraine"]),
  ...fromList("ru", ["russia"]),
  ...fromList("se", ["sweden"]),
  ...fromList("no", ["norway"]),
  ...fromList("dk", ["denmark"]),
  ...fromList("fi", ["finland"]),
  ...fromList("ee", ["estonia"]),
  ...fromList("lv", ["latvia"]),
  ...fromList("lt", ["lithuania"]),
  ...fromList("in", ["india", "bharat"]),
  ...fromList("pk", ["pakistan"]),
  ...fromList("bd", ["bangladesh"]),
  ...fromList("lk", ["sri lanka"]),
  ...fromList("sg", ["singapore"]),
  ...fromList("my", ["malaysia"]),
  ...fromList("id", ["indonesia"]),
  ...fromList("ph", ["philippines"]),
  ...fromList("vn", ["vietnam", "viet nam"]),
  ...fromList("th", ["thailand"]),
  ...fromList("jp", ["japan"]),
  ...fromList("kr", ["south korea", "korea"]),
  ...fromList("cn", ["china"]),
  ...fromList("hk", ["hong kong"]),
  ...fromList("tw", ["taiwan"]),
  ...fromList("au", ["australia"]),
  ...fromList("nz", ["new zealand"]),
  ...fromList("br", ["brazil", "brasil"]),
  ...fromList("mx", ["mexico"]),
  ...fromList("ar", ["argentina"]),
  ...fromList("cl", ["chile"]),
  ...fromList("co", ["colombia"]),
  ...fromList("pe", ["peru"]),
  ...fromList("uy", ["uruguay"]),
  ...fromList("za", ["south africa"]),
  ...fromList("ng", ["nigeria"]),
  ...fromList("ke", ["kenya"]),
  ...fromList("gh", ["ghana"]),
  ...fromList("eg", ["egypt"]),
  ...fromList("ma", ["morocco"]),
  ...fromList("il", ["israel"]),
  ...fromList("tr", ["turkey", "turkiye"]),
  ...fromList("ae", ["uae", "united arab emirates"]),
  ...fromList("sa", ["saudi arabia"]),
  // Multi-country scopes. Coarse on purpose - they are hiring regions, not
  // places, and splitting them buys nothing.
  ...fromList("eu", ["europe", "european union", "emea", "eea"]),
  ...fromList("apac", ["apac", "asia", "asia pacific"]),
  ...fromList("latam", ["latam", "latin america", "south america"]),
};

// Checked before cities, because a US/Canadian listing nearly always carries
// its state or province abbreviation and that resolves the city-name clashes
// ("Cambridge, MA" -> us, not the UK Cambridge; "Athens, GA" -> us).
const STATE_TO_COUNTRY: Record<string, string> = {
  ...fromList("us", [
    "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","ia","id","il","in",
    "ks","ky","la","ma","md","me","mi","mn","mo","ms","mt","nc","nd","ne","nh",
    "nj","nm","nv","ny","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","va",
    "vt","wa","wi","wv","wy","dc",
  ]),
  ...fromList("ca", ["on", "bc", "qc", "ab", "mb", "sk", "ns", "nb", "yt", "nu", "nt"]),
};

// Tech hubs, so "Berlin" and "Berlin, Germany" do not fingerprint apart. Not
// exhaustive by design; an unrecognized city falls through to its own token,
// which is still stable, just narrower.
const CITY_TO_COUNTRY: Record<string, string> = {
  ...fromList("us", [
    "new york","nyc","brooklyn","san francisco","sf","bay area","silicon valley",
    "los angeles","san diego","san jose","palo alto","mountain view","oakland",
    "sunnyvale","cupertino","santa monica","seattle","austin","boston","chicago",
    "denver","atlanta","miami","dallas","houston","phoenix","portland",
    "philadelphia","washington dc","salt lake city","minneapolis","detroit",
    "nashville","raleigh","charlotte","pittsburgh",
  ]),
  ...fromList("ca", ["toronto", "vancouver", "montreal", "ottawa", "calgary", "waterloo"]),
  ...fromList("uk", [
    "london","manchester","edinburgh","bristol","cambridge","oxford","birmingham",
    "leeds","glasgow","belfast",
  ]),
  ...fromList("de", [
    "berlin","munich","munchen","hamburg","frankfurt","cologne","koln","stuttgart",
    "dusseldorf","leipzig","karlsruhe",
  ]),
  ...fromList("nl", ["amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"]),
  ...fromList("fr", ["paris", "lyon", "toulouse", "marseille", "bordeaux", "lille", "nantes"]),
  ...fromList("es", ["madrid", "barcelona", "valencia", "malaga", "seville", "sevilla"]),
  ...fromList("pt", ["lisbon", "lisboa", "porto"]),
  ...fromList("ie", ["dublin", "cork", "galway"]),
  ...fromList("pl", ["warsaw", "warszawa", "krakow", "cracow", "wroclaw", "gdansk", "poznan"]),
  ...fromList("ch", ["zurich", "geneva", "zug", "basel", "lausanne"]),
  ...fromList("at", ["vienna", "wien", "graz"]),
  ...fromList("se", ["stockholm", "gothenburg", "malmo"]),
  ...fromList("no", ["oslo", "bergen", "trondheim"]),
  ...fromList("dk", ["copenhagen", "kobenhavn", "aarhus"]),
  ...fromList("fi", ["helsinki", "tampere", "espoo"]),
  ...fromList("cz", ["prague", "praha", "brno"]),
  ...fromList("it", ["milan", "milano", "rome", "roma", "turin", "torino", "bologna"]),
  ...fromList("be", ["brussels", "antwerp", "ghent"]),
  ...fromList("in", [
    "bangalore","bengaluru","mumbai","bombay","delhi","new delhi","gurgaon",
    "gurugram","noida","hyderabad","pune","chennai","kolkata","ahmedabad",
    "jaipur","kochi","indore","chandigarh","coimbatore",
  ]),
  ...fromList("ae", ["dubai", "abu dhabi"]),
  ...fromList("il", ["tel aviv", "jerusalem", "haifa"]),
  ...fromList("au", ["sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra"]),
  ...fromList("nz", ["auckland", "wellington"]),
  ...fromList("jp", ["tokyo", "osaka", "kyoto"]),
  ...fromList("kr", ["seoul"]),
  ...fromList("cn", ["beijing", "shanghai", "shenzhen", "guangzhou", "hangzhou"]),
  ...fromList("tw", ["taipei"]),
  ...fromList("br", [
    "sao paulo","rio de janeiro","belo horizonte","curitiba","porto alegre",
    "florianopolis","recife",
  ]),
  ...fromList("mx", ["mexico city", "guadalajara", "monterrey"]),
  ...fromList("ar", ["buenos aires", "cordoba", "rosario"]),
  ...fromList("cl", ["santiago"]),
  ...fromList("co", ["bogota", "medellin", "cali"]),
  ...fromList("za", ["cape town", "johannesburg", "durban", "pretoria"]),
  ...fromList("ng", ["lagos", "abuja"]),
  ...fromList("ke", ["nairobi"]),
  ...fromList("eg", ["cairo"]),
  ...fromList("tr", ["istanbul", "ankara", "izmir"]),
  ...fromList("gr", ["athens", "thessaloniki"]),
  ...fromList("hu", ["budapest"]),
  ...fromList("ro", ["bucharest", "cluj", "cluj napoca", "iasi", "timisoara"]),
  ...fromList("bg", ["sofia", "plovdiv"]),
  ...fromList("rs", ["belgrade", "novi sad"]),
  ...fromList("hr", ["zagreb", "split"]),
  ...fromList("ua", ["kyiv", "kiev", "lviv", "kharkiv"]),
  ...fromList("ru", ["moscow", "saint petersburg"]),
  ...fromList("ph", ["manila", "cebu"]),
  ...fromList("id", ["jakarta", "bali"]),
  ...fromList("my", ["kuala lumpur"]),
  ...fromList("vn", ["hanoi", "ho chi minh city", "saigon", "da nang"]),
  ...fromList("th", ["bangkok"]),
  ...fromList("pk", ["karachi", "lahore", "islamabad"]),
  ...fromList("bd", ["dhaka"]),
  ...fromList("lk", ["colombo"]),
  ...fromList("sg", ["singapore"]),
};

// Qualifiers boards wrap around a place name. Removed as a second attempt, not
// the first, so "Bay Area" still matches the city table before "area" is taken
// off it - but "USA Only" and "Greater London Area" still resolve.
const LOCATION_NOISE = new Set([
  "only",
  "based",
  "region",
  "area",
  "greater",
  "metro",
  "the",
  "and",
  "or",
  "preferred",
  "timezone",
  "timezones",
  "tz",
  "country",
  "countries",
  "hybrid",
  "office",
  "optional",
  "friendly",
]);

// Location strings that carry no more information than an empty one.
const MEANINGLESS_LOCATIONS = new Set([
  "multiple locations",
  "multiple",
  "various",
  "various locations",
  "other",
  "unknown",
  "unspecified",
  "not specified",
  "not applicable",
  "n a",
  "na",
  "none",
  "null",
  "undefined",
  "tbd",
]);

/** Segment spellings to try against a table, most faithful first. */
function lookupKeys(segment: string): string[] {
  const tokens = segment.split(" ").filter(Boolean);
  const denoised = tokens.filter((t) => !LOCATION_NOISE.has(t));
  const keys = [segment];
  if (denoised.length && denoised.length !== tokens.length) {
    keys.push(denoised.join(" "));
  }
  // Individual words are a last resort and only for words longer than two
  // characters: a bare "or" inside "Berlin or Munich" must not read as Oregon.
  for (const token of denoised) if (token.length > 2) keys.push(token);
  return keys;
}

/**
 * Reduces a location to a coarse bucket.
 *
 * Buckets are: "remote" (the explicit remote flag, or text that reads as
 * location-independent), a country/region code, a bare city token for places
 * the table does not know, or "unknown" when there is nothing to go on.
 *
 * Two deliberate coarsenings:
 *
 *  - `remote` is tri-state, and only an explicit `false` opts out of the
 *    remote bucket. `true` obviously means remote; `undefined` means "we do
 *    not know" (Adzuna passes it honestly now, and so does a LinkedIn alert
 *    whose location line names no arrangement), and bucketing a possibly-
 *    remote job by an office city (Adzuna still ships "London, UK") would
 *    fragment the same remote job across boards, which is exactly what this
 *    key exists to prevent. Only a positively-known on-site or hybrid job -
 *    `remote === false` - falls through to the location text below.
 *  - Sub-country detail is discarded, so "San Francisco, CA" and
 *    "New York, NY" share the "us" bucket. That can merge two genuinely
 *    different postings only when the company AND the normalized title also
 *    match; over-splitting, by contrast, defeats the whole key.
 */
export function locationBucket(raw?: string, remote?: boolean): string {
  if (remote !== false) return "remote";

  const folded = foldCase(raw ?? "")
    .replace(/\./g, "")
    .replace(/[^a-z0-9,/|;()\-–\s]+/g, " ");
  const flat = folded.replace(/[^a-z0-9]+/g, " ").trim();
  if (!flat) return "unknown";
  if (REMOTE_HINT_RE.test(flat)) return "remote";
  if (MEANINGLESS_LOCATIONS.has(flat)) return "unknown";

  const segments = folded
    .split(/[,/|;()]|\s[-–]\s/)
    .map((s) => s.replace(/[^a-z0-9]+/g, " ").trim())
    .filter(Boolean);
  if (!segments.length) return "unknown";

  // Country name > state/province abbreviation > city. See STATE_TO_COUNTRY on
  // why the abbreviation outranks the city table.
  for (const table of [COUNTRY_ALIASES, STATE_TO_COUNTRY, CITY_TO_COUNTRY]) {
    for (const segment of segments) {
      for (const key of lookupKeys(segment)) {
        const hit = table[key];
        if (hit) return hit;
      }
    }
  }

  // Unrecognized place: keep the most specific-looking segment verbatim. It is
  // still deterministic, just a narrower bucket than a known country.
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * The cross-source identity key for a job: `company|title|locationBucket`.
 *
 * Stable by construction - no hashing, no clock, no randomness - because it is
 * written to jobs.fingerprint and compared against rows from previous runs.
 * Kept human-readable for the same reason: a wrong merge has to be diagnosable
 * by looking at the column.
 *
 * A missing or placeholder employer ("Unknown", which WeWorkRemotely and
 * Himalayas emit on a parse miss) becomes "anon" rather than being trusted as
 * a name, so such rows only merge when the full title and bucket also match.
 */
export function fingerprintJob(
  job: Pick<RawJob, "title" | "company" | "location" | "remote">
): string {
  const company = normalizeCompany(job.company ?? "");
  const title = normalizeTitle(job.title ?? "");
  const bucket = locationBucket(job.location, job.remote);
  const companySlot = isPlaceholderCompany(company) ? ANON : company;
  return `${companySlot}|${title || "untitled"}|${bucket}`;
}

/**
 * The identity key for a lead: `company|title|lead`.
 *
 * The trailing "lead" both fills the slot a job spends on location (leads have
 * none) and keeps lead keys from ever colliding with job keys.
 *
 * Leads frequently have no client name - an Upwork or WWR-contract posting is
 * often anonymous - and collapsing all of those onto one key would throw away
 * most of the pipeline's leads. Anonymous leads therefore carry the "anon"
 * marker plus the FULL normalized title, with decorations left in: for a
 * nameless lead the title is the only identity available, so nothing that
 * distinguishes one from another is allowed to be stripped.
 */
export function fingerprintLead(
  lead: Pick<RawLead, "title" | "clientOrCompany">
): string {
  const company = normalizeCompany(lead.clientOrCompany ?? "");
  if (isPlaceholderCompany(company)) {
    const fullTitle = normalizeText(lead.title ?? "");
    return `${ANON}|${fullTitle || "untitled"}|lead`;
  }
  const title = normalizeTitle(lead.title ?? "");
  return `${company}|${title || "untitled"}|lead`;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

// Chrome that inflates a description's length without adding information. The
// list is deliberately short: it targets phrases that are boilerplate in every
// posting, not anything a reader would want in a cover letter.
const BOILERPLATE_RE: RegExp[] = [
  /equal opportunity employer[^.]*\./g,
  /without regard to race[^.]*\./g,
  /all qualified applicants[^.]*\./g,
  /we are an equal opportunity[^.]*\./g,
  /apply (now|here|today)/g,
  /click here[^.]*\./g,
  /share this job/g,
  /view (this )?job/g,
  /unsubscribe[^.]*\./g,
  /cookie (policy|notice)/g,
  /privacy policy/g,
  /all rights reserved/g,
  /powered by \w+/g,
  /seniority level|employment type|job function|job type/g,
];

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  mdash: "-",
  ndash: "-",
  hellip: "...",
};

/** Length of the actual prose in a description, ignoring markup and chrome. */
function informativeLength(text: string): number {
  let out = text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-z]+|#\d+);/gi, (_m, name: string) => {
      return HTML_ENTITIES[name.toLowerCase()] ?? " ";
    })
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase();
  for (const pattern of BOILERPLATE_RE) out = out.replace(pattern, " ");
  return out.replace(/\s+/g, " ").trim().length;
}

/**
 * Picks the more informative of two descriptions when merging duplicate rows.
 *
 * Raw length is a bad proxy on its own: a source that ships a wall of HTML
 * wrappers, tracking links and an EEO paragraph would beat a source that ships
 * three real paragraphs of plain text. Markup, URLs and known boilerplate are
 * stripped before the comparison, but the ORIGINAL string is returned - the
 * stripping is a measuring device, not an edit.
 *
 * Ties go to `a`, so merging is order-stable.
 */
export function pickRicherDescription(
  a?: string,
  b?: string
): string | undefined {
  const candidates = [a, b].filter(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  );
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];

  const [first, second] = candidates;
  return informativeLength(second) > informativeLength(first) ? second : first;
}
