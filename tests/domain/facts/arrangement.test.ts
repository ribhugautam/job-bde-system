import { describe, it, expect } from "vitest";
import { deriveArrangement } from "@/lib/domain/facts/arrangement";

describe("deriveArrangement", () => {
  // Strings taken verbatim from production LinkedIn cards.
  it("reads (On-site) from a location suffix", () => {
    expect(deriveArrangement({ location: "Bengaluru (On-site)" })).toBe("onsite");
  });

  it("reads (Hybrid) from a location suffix", () => {
    expect(
      deriveArrangement({ location: "Pune/Pimpri-Chinchwad Area (Hybrid)" })
    ).toBe("hybrid");
  });

  it("reads (Remote) from a location suffix", () => {
    expect(deriveArrangement({ location: "India (Remote)" })).toBe("remote");
  });

  it("prefers hybrid over onsite when both words appear", () => {
    expect(deriveArrangement({ location: "Hybrid - 3 days on-site" })).toBe(
      "hybrid"
    );
  });

  it("treats a bare city as unknown, not onsite", () => {
    expect(deriveArrangement({ location: "Gurgaon, Haryana, India" })).toBe(
      "unknown"
    );
  });

  it("honours an explicit source flag when the location is silent", () => {
    expect(
      deriveArrangement({ location: "Gurgaon, Haryana, India", remote: true })
    ).toBe("remote");
  });

  it("lets the location override a contradicting source flag", () => {
    // Remote-only boards hardcode remote:true. If the location says on-site,
    // the location is the more specific evidence.
    expect(deriveArrangement({ location: "Bengaluru (On-site)", remote: true })).toBe(
      "onsite"
    );
  });

  it("reads a remote tag", () => {
    expect(deriveArrangement({ tags: ["remote", "react"] })).toBe("remote");
  });

  it("is unknown with no evidence at all", () => {
    expect(deriveArrangement({})).toBe("unknown");
  });

  it("recognises worldwide phrasing as remote", () => {
    expect(deriveArrangement({ location: "Anywhere in the World" })).toBe(
      "remote"
    );
  });
});
