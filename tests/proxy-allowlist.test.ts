import { describe, it, expect } from "vitest";
import { isPublic, config } from "@/proxy";

// The allowlist in proxy.ts is the one place a route can be exposed by
// accident. Everything else is deny-by-default, so a mistake here is the only
// way the dashboard, the resume, or the "send real email" endpoints become
// reachable without a session.

describe("routes that MUST require a session", () => {
  const gated = [
    "/",
    "/dashboard",
    "/dashboard/queue",
    "/dashboard/jobs",
    "/dashboard/applications",
    "/dashboard/freelance",
    "/dashboard/resume",
    "/dashboard/settings",
    "/api/actions/run-pipeline",
    "/api/actions/send-application",
    "/api/actions/send-outreach",
    "/api/actions/mark-applied",
    "/api/actions/update-status",
    "/api/actions/upload-resume",
  ];

  for (const path of gated) {
    it(`${path} is not public`, () => {
      expect(isPublic(path)).toBe(false);
    });
  }

  it("keeps the manual-run endpoint gated", () => {
    // This one matters most. /api/actions/run-pipeline sends real applications,
    // pitches and follow-ups, and unlike /api/cron/daily it has NO secret of
    // its own — the session cookie is its only protection. If it were ever
    // added to the allowlist, anyone on the internet could trigger outbound
    // email from this deployment.
    expect(isPublic("/api/actions/run-pipeline")).toBe(false);
  });
});

describe("routes that are intentionally public", () => {
  it("allows the login page and its endpoints, or nobody could ever sign in", () => {
    expect(isPublic("/login")).toBe(true);
    expect(isPublic("/api/auth/login")).toBe(true);
    expect(isPublic("/api/auth/logout")).toBe(true);
  });

  it("allows the cron path, which carries its own CRON_SECRET check", () => {
    // Vercel Cron cannot send a browser cookie, so this route is outside the
    // session gate and fail-closed on CRON_SECRET instead.
    expect(isPublic("/api/cron/daily")).toBe(true);
  });
});

describe("the allowlist cannot be widened by a crafted path", () => {
  it("does not match near-misses of the login endpoints", () => {
    expect(isPublic("/login/../dashboard")).toBe(false);
    expect(isPublic("/loginx")).toBe(false);
    expect(isPublic("/api/auth/login/../../actions/run-pipeline")).toBe(false);
    expect(isPublic("/api/authXlogin")).toBe(false);
  });

  it("does not treat a path merely containing /api/cron/ as public", () => {
    // startsWith, not includes — otherwise /api/actions/x?next=/api/cron/ or a
    // nested path would slip through.
    expect(isPublic("/api/actions/run-pipeline/api/cron/")).toBe(false);
    expect(isPublic("/dashboard/api/cron/daily")).toBe(false);
  });

  it("is case-sensitive rather than accidentally lenient", () => {
    expect(isPublic("/API/CRON/daily")).toBe(false);
    expect(isPublic("/Login")).toBe(false);
  });
});

describe("the matcher covers new routes automatically", () => {
  it("excludes only Next's own static assets", () => {
    const [pattern] = config.matcher;
    expect(pattern).toContain("_next/static");
    expect(pattern).toContain("_next/image");
    expect(pattern).toContain("favicon.ico");
  });

  it("actually matches application routes", () => {
    // Guards the deny-by-default property: any page or API route added later is
    // gated without anyone remembering to register it.
    const re = new RegExp(config.matcher[0]);
    for (const path of [
      "/dashboard/queue",
      "/api/actions/run-pipeline",
      "/some/route/added/next/year",
    ]) {
      expect(re.test(path), `matcher should cover ${path}`).toBe(true);
    }
  });
});
