import { describe, it, expect } from "vitest";
import { WELLFOUND_ALERTS, INDEED_ALERTS } from "@/lib/infra/sources/email/registry";

describe("alert source registry", () => {
  it("uses the persisted source names", () => {
    expect(WELLFOUND_ALERTS.name).toBe("wellfound_alert");
    expect(INDEED_ALERTS.name).toBe("indeed_alert");
  });

  it("targets the right sender domains", () => {
    expect(WELLFOUND_ALERTS.fromDomain).toBe("wellfound.com");
    expect(INDEED_ALERTS.fromDomain).toBe("indeed.com");
  });

  it("filters Wellfound's non-job company-update digests", () => {
    const keep = WELLFOUND_ALERTS.subjectFilter!;
    expect(keep("New jobs: Full Stack Engineer at Seamless.finance and 3 more jobs")).toBe(true);
    expect(keep("An update from Univaens, ParallelDots and 37 others")).toBe(false);
    expect(keep("An update from Flowbit, Edensign and 5 others")).toBe(false);
  });

  it("keeps Indeed's job digests and rejects obvious non-job mail", () => {
    const keep = INDEED_ALERTS.subjectFilter!;
    expect(keep("Apply to jobs at Wits Innovation Lab, snabs solution and Yaarify")).toBe(true);
    expect(keep("Front End Developer @ Techihire")).toBe(true);
    expect(keep("Your application was viewed")).toBe(false);
    expect(keep("Reset your password")).toBe(false);
  });
});
