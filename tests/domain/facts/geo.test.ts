// tests/domain/facts/geo.test.ts
import { describe, it, expect } from "vitest";
import { deriveGeo } from "@/lib/domain/facts/geo";

describe("deriveGeo", () => {
  // All strings below are real `location` values from the production database.
  it("treats worldwide phrasing as unrestricted", () => {
    expect(deriveGeo("Anywhere in the World")).toEqual({
      regions: ["worldwide"],
      eligibility: "worldwide",
    });
    expect(deriveGeo("Worldwide").eligibility).toBe("worldwide");
  });

  it("treats a US-only remote role as restricted", () => {
    expect(deriveGeo("USA")).toEqual({ regions: ["us"], eligibility: "restricted" });
    expect(deriveGeo("Remote - US").eligibility).toBe("restricted");
  });

  it("treats Europe and LATAM as restricted", () => {
    expect(deriveGeo("Europe").eligibility).toBe("restricted");
    expect(deriveGeo("LATAM").eligibility).toBe("restricted");
    expect(deriveGeo("Remote UK").eligibility).toBe("restricted");
  });

  it("treats an Indian city as eligible", () => {
    expect(deriveGeo("Bengaluru, Karnataka, India")).toEqual({
      regions: ["in"],
      eligibility: "eligible",
    });
    expect(deriveGeo("Gurgaon, Haryana, India").eligibility).toBe("eligible");
  });

  it("recognises Indian cities without the country name", () => {
    expect(deriveGeo("Mohali district").eligibility).toBe("eligible");
    expect(deriveGeo("Pune Division").eligibility).toBe("eligible");
    expect(deriveGeo("Noida").eligibility).toBe("eligible");
  });

  it("treats APAC as eligible", () => {
    expect(deriveGeo("APAC").eligibility).toBe("eligible");
  });

  it("is eligible when a multi-region list includes India", () => {
    expect(deriveGeo("Remote (US; IN; DE)").eligibility).toBe("eligible");
  });

  it("is restricted when a multi-region list excludes India", () => {
    expect(deriveGeo("Remote (GB; DE; NL; FR)").eligibility).toBe("restricted");
  });

  it("is unknown for an unrecognised place", () => {
    expect(deriveGeo("Chinchilla")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("is unknown for a missing or empty location", () => {
    expect(deriveGeo(undefined).eligibility).toBe("unknown");
    expect(deriveGeo("").eligibility).toBe("unknown");
  });

  it("tolerates the trailing-comma junk Adzuna emits", () => {
    // Real value: "Bedford, " — a bare city, so still unknown, but it must not
    // throw or produce a stray empty region token.
    expect(deriveGeo("Bedford, ")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("prefers worldwide over an incidental country mention", () => {
    expect(deriveGeo("Remote, Worldwide (US timezone overlap)").eligibility).toBe(
      "worldwide"
    );
  });

  it("treats an ambiguous Indian city name as eligible when no other country is named", () => {
    expect(deriveGeo("Hyderabad (On-site)").eligibility).toBe("eligible");
    expect(deriveGeo("Delhi, Delhi, India").eligibility).toBe("eligible");
  });

  it("does not treat a same-named foreign place as India", () => {
    expect(deriveGeo("Hyderabad, Pakistan")).toEqual({ regions: [], eligibility: "unknown" });
    expect(deriveGeo("Kochi, Japan")).toEqual({ regions: [], eligibility: "unknown" });
    expect(deriveGeo("Surat Thani, Thailand")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("resolves an ambiguous city name against a competing country to restricted", () => {
    expect(deriveGeo("Delhi, New York, USA").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi, Ontario, Canada").eligibility).toBe("restricted");
  });

  it("recognises the dotted U.S. abbreviation as restricted", () => {
    expect(deriveGeo("Remote - U.S.").eligibility).toBe("restricted");
    expect(deriveGeo("U.S. based").eligibility).toBe("restricted");
  });

  it("does not match 'us' inside an ordinary word", () => {
    expect(deriveGeo("Bus Depot, Ontario")).toEqual({ regions: [], eligibility: "unknown" });
  });

  it("does not veto an ambiguous city on an incidental country mention", () => {
    // A country named in passing (timezone note, client base) is not a
    // stated restriction — only a location COMPONENT that IS the country
    // vetoes. See the "still veto" cases in the tests above for contrast.
    expect(deriveGeo("Hyderabad-based team serving US clients").eligibility).toBe(
      "eligible"
    );
    expect(deriveGeo("Hyderabad (IST, overlapping with US hours)").eligibility).toBe(
      "eligible"
    );
    expect(deriveGeo("Delhi (remote, US timezone overlap)").eligibility).toBe("eligible");
    expect(deriveGeo("Kochi, working with US and EU clients").eligibility).toBe("eligible");
  });

  it("treats a list naming both India and another country as eligible", () => {
    expect(deriveGeo("India / United States").eligibility).toBe("eligible");
    expect(deriveGeo("Remote (IN; US)").eligibility).toBe("eligible");
  });

  it("vetoes a country stated parenthetically right after the ambiguous city", () => {
    // Parentheses are a separator, not something to strip: "Hyderabad
    // (Pakistan)" must isolate "Pakistan" into its own component just like
    // "Hyderabad, Pakistan" does, even though there is no comma before the
    // paren. A prior fix stripped trailing parentheticals instead, which
    // discarded "(Pakistan)" outright and let this slip through as eligible.
    expect(deriveGeo("Hyderabad (Pakistan)")).toEqual({ regions: [], eligibility: "unknown" });
    expect(deriveGeo("Delhi (Canada)").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi (Ontario, Canada)").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi, (Canada)").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi, Canada)").eligibility).toBe("restricted");
    expect(deriveGeo("Canada (Remote)").eligibility).toBe("restricted");
  });

  it("vetoes an ambiguous city against a competing country in more component shapes", () => {
    expect(deriveGeo("Delhi / Canada").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi; Japan")).toEqual({ regions: [], eligibility: "unknown" });
    expect(deriveGeo("Delhi, United States").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi, New Zealand").eligibility).toBe("restricted");
    expect(deriveGeo("USA, Delhi").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi , Canada ").eligibility).toBe("restricted");
    expect(deriveGeo("Delhi, CANADA").eligibility).toBe("restricted");
  });

  it("does not veto when the trailing country component is not an exact match", () => {
    expect(deriveGeo("Delhi, Canada extra").eligibility).toBe("eligible");
  });

  it("recognises Indian cities with a parenthetical arrangement note", () => {
    // Real production location values.
    expect(deriveGeo("Mohali district (On-site)").eligibility).toBe("eligible");
    expect(deriveGeo("Pune Division (Hybrid)").eligibility).toBe("eligible");
  });
});

describe("single-country region lists", () => {
  it("reads a one-code list, which Y Combinator emits", () => {
    expect(deriveGeo("Remote (IN)").eligibility).toBe("eligible");
    expect(deriveGeo("Remote (US)").eligibility).toBe("restricted");
  });

  it("still handles multi-code lists exactly as before", () => {
    expect(deriveGeo("Remote (IN; US)").eligibility).toBe("eligible");
    expect(deriveGeo("Remote (GB; DE; NL; FR)").eligibility).toBe("restricted");
  });

  it("does not mistake a parenthetical word for a country code", () => {
    // Two-letter uppercase only; "(Remote)" and "(Hybrid)" must not match.
    expect(deriveGeo("Bengaluru (Hybrid)").eligibility).toBe("eligible");
    expect(deriveGeo("Chinchilla (Remote)").eligibility).toBe("unknown");
  });

  it("does not read a trailing word after a code as part of the list", () => {
    // "(IN Nowhere)" is not an anchored two-letter code list — the group must
    // reach the closing paren directly, so REGION_LIST_RE does not match here.
    // (Separately, "Remote (IN India)" resolves to eligible, but that is the
    // literal word "India" being recognised on its own merits, not the region
    // list logic — see the India-token tests above.)
    expect(deriveGeo("Remote (IN Nowhere)").eligibility).toBe("unknown");
  });

  it("recognises Faridabad, seen in real Wellfound data", () => {
    expect(deriveGeo("Faridabad").eligibility).toBe("eligible");
  });
});

describe("worldwide phrasing gaps found in real Y Combinator/Wellfound data", () => {
  it("treats 'Everywhere' alone as unrestricted", () => {
    expect(deriveGeo("Everywhere")).toEqual({
      regions: ["worldwide"],
      eligibility: "worldwide",
    });
  });

  it("treats Wellfound's 'Remote only, Everywhere' as unrestricted", () => {
    expect(deriveGeo("Remote only, Everywhere").eligibility).toBe("worldwide");
  });

  it("prefers worldwide over an Indian city in the same real Wellfound string", () => {
    // Real value (after the source strips the leading "Onsite or remote, "):
    // "Faridabad, Remote (Everywhere)". Worldwide wins outright per precedence,
    // even though Faridabad alone would otherwise resolve to eligible.
    expect(deriveGeo("Faridabad, Remote (Everywhere)").eligibility).toBe("worldwide");
  });
});
