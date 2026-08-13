import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/config/env";
import {
  enrichDelayMs,
  enrichSettings,
  extractJobId,
  fetchJobDescription,
  parseJobPage,
  sleep,
} from "@/lib/infra/linkedin/enrich";

// ---------------------------------------------------------------------------
// Enrichment is best-effort by design: it fetches a public, unauthenticated
// job page and, when that does not work, the job stays scored on its title.
// So the two things worth testing hard are (a) that we read the description
// correctly when the page gives us one, and (b) that every failure mode comes
// back as a value rather than an exception - a blocked fetch must never take
// a pipeline run down with it.
// ---------------------------------------------------------------------------

/** Minimal Response stand-in: fetchJobDescription only uses status/ok/text. */
function response(status: number, body = ""): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: (...args: unknown[]) => unknown) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

const jsonLdPage = (description: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<title>Vercel hiring Senior Full Stack Engineer</title>
<script type="application/ld+json">
{"@context":"http://schema.org","@type":"WebPage","url":"https://www.linkedin.com/jobs/view/3812345678"}
</script>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "http://schema.org",
  "@type": "JobPosting",
  title: "Senior Full Stack Engineer",
  hiringOrganization: { "@type": "Organization", name: "Vercel" },
  jobLocation: { "@type": "Place", address: { addressCountry: "GB" } },
  datePosted: "2026-08-11",
  description,
})}
</script>
</head>
<body>
<section class="core-section-container">
<div class="show-more-less-html__markup">This is the CSS-selector copy, which must lose to JSON-LD.</div>
</section>
</body>
</html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe("extractJobId", () => {
  it("reads the id from a canonical job URL", () => {
    expect(extractJobId("https://www.linkedin.com/jobs/view/3812345678/")).toBe(
      "3812345678"
    );
    expect(extractJobId("https://www.linkedin.com/jobs/view/3812345678")).toBe(
      "3812345678"
    );
  });

  it("reads the id through the tracking parameters alert emails add", () => {
    const url =
      "https://www.linkedin.com/comm/jobs/view/3812345678/?trackingId=Rr8%2Bd1kPQ3yq9m0Yb%2FVzZA%3D%3D" +
      "&refId=1a2b3c-m9x8w7v6-qr&midToken=AQF7uK1t9Zx0Ug&trk=eml-email_job_alert_digest_01-job_card-0-jobcard_title" +
      "&trkEmail=eml-email_job_alert_digest_01-job_card-0-jobcard_title-null-1a2b3c~m9x8w7v6~qr";
    expect(extractJobId(url)).toBe("3812345678");
  });

  it("handles the /comm/ variant and protocol-relative or bare hosts", () => {
    expect(extractJobId("https://www.linkedin.com/comm/jobs/view/4011223344")).toBe(
      "4011223344"
    );
    expect(extractJobId("//linkedin.com/comm/jobs/view/4011223344/")).toBe(
      "4011223344"
    );
    expect(extractJobId("http://uk.linkedin.com/jobs/view/999/")).toBe("999");
  });

  it("reads the id out of a search page's currentJobId parameter", () => {
    expect(
      extractJobId(
        "https://www.linkedin.com/jobs/search/?currentJobId=3745559001&keywords=react"
      )
    ).toBe("3745559001");
  });

  it("returns undefined for anything that is not a LinkedIn job URL", () => {
    for (const garbage of [
      "",
      "   ",
      "not a url at all",
      "https://example.com/jobs/view/3812345678",
      "https://www.linkedin.com/jobs/search/?keywords=react",
      "https://www.linkedin.com/in/ada-lovelace/",
      "https://www.linkedin.com/jobs/view/not-a-number",
      "javascript:alert(1)",
    ]) {
      expect(extractJobId(garbage)).toBeUndefined();
    }
  });
});

describe("parseJobPage - JSON-LD", () => {
  it("prefers the JSON-LD JobPosting description over CSS selectors", () => {
    // LinkedIn ships the description as entity-escaped HTML inside the JSON
    // string, so it needs decoding AND tag stripping.
    const html = jsonLdPage(
      "&lt;p&gt;&lt;strong&gt;About the role&lt;/strong&gt;&lt;/p&gt;" +
        "&lt;ul&gt;&lt;li&gt;Ship React &amp;amp; Next.js features&lt;/li&gt;" +
        "&lt;li&gt;5+ years of TypeScript&lt;/li&gt;&lt;/ul&gt;"
    );
    const text = parseJobPage(html);
    expect(text).toBeDefined();
    expect(text).toContain("About the role");
    expect(text).toContain("Ship React & Next.js features");
    expect(text).toContain("5+ years of TypeScript");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("CSS-selector copy");
  });

  it("handles a description that is plain (not double-escaped) HTML", () => {
    const html = jsonLdPage("<p>Build the platform.</p><p>Remote, Worldwide.</p>");
    expect(parseJobPage(html)).toBe("Build the platform.\nRemote, Worldwide.");
  });

  it("finds the JobPosting inside an array or an @graph wrapper", () => {
    const graph = `<html><head><script type="application/ld+json">${JSON.stringify(
      [
        { "@type": "BreadcrumbList", itemListElement: [] },
        {
          "@context": "http://schema.org",
          "@graph": [
            { "@type": "Organization", name: "Vercel" },
            { "@type": ["JobPosting"], description: "Graph description here." },
          ],
        },
      ]
    )}</script></head><body></body></html>`;
    expect(parseJobPage(graph)).toBe("Graph description here.");
  });

  it("ignores JSON-LD blocks that are not JobPosting or are unparseable", () => {
    const html = `<html><head>
<script type="application/ld+json">{ this is not json at all </script>
<script type="application/ld+json">{"@type":"Organization","description":"We build things."}</script>
</head><body>
<div class="show-more-less-html__markup"><p>Real description from the fallback container.</p></div>
</body></html>`;
    expect(() => parseJobPage(html)).not.toThrow();
    expect(parseJobPage(html)).toBe("Real description from the fallback container.");
  });
});

describe("parseJobPage - fallback containers", () => {
  it("uses .show-more-less-html__markup when there is no JSON-LD", () => {
    const html = `<html><body>
<div class="description__text">
  <div class="show-more-less-html__markup">
    <p>We are hiring a Full Stack Engineer.</p>
    <ul><li>Next.js</li><li>Drizzle</li></ul>
  </div>
</div>
</body></html>`;
    const text = parseJobPage(html);
    expect(text).toContain("We are hiring a Full Stack Engineer.");
    expect(text).toContain("Next.js");
    expect(text).toContain("Drizzle");
    expect(text).not.toContain("<li>");
  });

  it("uses .description__text when the inner markup class is gone", () => {
    const html = `<html><body>
<section class="description__text">The whole description, unwrapped.</section>
</body></html>`;
    expect(parseJobPage(html)).toBe("The whole description, unwrapped.");
  });

  it("decodes HTML entities and non-breaking spaces into readable text", () => {
    const html = `<html><body><div class="description__text">
<p>R&amp;D team &#8226; we&#39;re hiring</p><p>Salary:&nbsp;&pound;80,000&nbsp;&#8211;&nbsp;&pound;95,000</p>
<p>Must know &lt;canvas&gt; APIs</p>
</div></body></html>`;
    const text = parseJobPage(html) ?? "";
    expect(text).toContain("R&D team • we're hiring");
    expect(text).toContain("Salary: £80,000 – £95,000");
    expect(text).toContain("Must know <canvas> APIs");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&nbsp;");
  });

  it("strips scripts and styles out of the description container", () => {
    const html = `<html><body><div class="description__text">
<style>.x{color:red}</style><script>window.__x=1;</script><p>Actual copy.</p>
</div></body></html>`;
    const text = parseJobPage(html) ?? "";
    expect(text).toBe("Actual copy.");
  });
});

describe("parseJobPage - nothing to extract", () => {
  it("returns undefined for an empty or whitespace-only page", () => {
    expect(parseJobPage("")).toBeUndefined();
    expect(parseJobPage("   \n  ")).toBeUndefined();
  });

  it("returns undefined when neither JSON-LD nor a known container is present", () => {
    const authWall = `<html><body>
<h1>Sign in to view this job</h1>
<form action="/uas/login-submit"><button>Sign in</button></form>
</body></html>`;
    expect(parseJobPage(authWall)).toBeUndefined();
  });

  it("returns undefined when the container exists but is empty", () => {
    expect(
      parseJobPage(`<html><body><div class="description__text">  </div></body></html>`)
    ).toBeUndefined();
  });
});

describe("fetchJobDescription - request shape", () => {
  it("fetches the canonical public page with no credentials attached", async () => {
    const mock = stubFetch(async () =>
      response(200, jsonLdPage("<p>Ship things.</p>"))
    );
    await fetchJobDescription("3812345678");

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.linkedin.com/jobs/view/3812345678");
    expect(url).not.toContain("trackingId");
    expect(init.method).toBe("GET");
    // The whole point: no session, no cookie, nothing that identifies an
    // account. If this assertion ever has to change, something is wrong.
    expect(init.credentials).toBe("omit");
    const headerNames = Object.keys(init.headers as Record<string, string>).map(
      (h) => h.toLowerCase()
    );
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("csrf-token");
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(
      /job-bde-system/
    );
  });
});

describe("fetchJobDescription - status to outcome mapping", () => {
  it("200 with a readable description -> ok", async () => {
    stubFetch(async () =>
      response(200, jsonLdPage("<p>We are hiring a Full Stack Engineer.</p>"))
    );
    const result = await fetchJobDescription("3812345678");
    expect(result).toEqual({
      jobId: "3812345678",
      description: "We are hiring a Full Stack Engineer.",
      outcome: "ok",
      httpStatus: 200,
    });
  });

  it("200 with no description on the page -> not_found, never a fake ok", async () => {
    stubFetch(async () => response(200, "<html><body><h1>Sign in</h1></body></html>"));
    const result = await fetchJobDescription("3812345678");
    expect(result.outcome).toBe("not_found");
    expect(result.description).toBeUndefined();
    expect(result.httpStatus).toBe(200);
  });

  it("404 and 410 -> not_found", async () => {
    for (const status of [404, 410]) {
      stubFetch(async () => response(status, "Not Found"));
      const result = await fetchJobDescription("3812345678");
      expect(result).toEqual({
        jobId: "3812345678",
        outcome: "not_found",
        httpStatus: status,
      });
    }
  });

  it("429 -> blocked, and does NOT throw", async () => {
    stubFetch(async () => response(429, "Too Many Requests"));

    // Stated twice on purpose: the pipeline must survive being rate limited.
    await expect(fetchJobDescription("3812345678")).resolves.toEqual({
      jobId: "3812345678",
      outcome: "blocked",
      httpStatus: 429,
    });

    let threw = false;
    try {
      await fetchJobDescription("3812345678");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("403 -> blocked", async () => {
    stubFetch(async () => response(403, "Forbidden"));
    const result = await fetchJobDescription("3812345678");
    expect(result.outcome).toBe("blocked");
    expect(result.httpStatus).toBe(403);
    expect(result.description).toBeUndefined();
  });

  it("any other non-ok status -> error", async () => {
    for (const status of [500, 502, 301]) {
      stubFetch(async () => response(status, ""));
      const result = await fetchJobDescription("3812345678");
      expect(result.outcome).toBe("error");
      expect(result.httpStatus).toBe(status);
    }
  });
});

describe("fetchJobDescription - failures never escape", () => {
  it("a network failure -> error, not a rejection", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed: ENOTFOUND www.linkedin.com");
    });
    await expect(fetchJobDescription("3812345678")).resolves.toEqual({
      jobId: "3812345678",
      outcome: "error",
    });
  });

  it("an aborted/timed-out request -> error", async () => {
    stubFetch(async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      });
    });
    const result = await fetchJobDescription("3812345678");
    expect(result.outcome).toBe("error");
    expect(result.description).toBeUndefined();
  });

  it("a body that fails to read -> error", async () => {
    stubFetch(async () => ({
      status: 200,
      ok: true,
      text: async () => {
        throw new Error("stream closed");
      },
    }));
    const result = await fetchJobDescription("3812345678");
    expect(result.outcome).toBe("error");
  });

  it("always reports the job id it was asked about", async () => {
    stubFetch(async () => response(503, ""));
    expect((await fetchJobDescription("4011223344")).jobId).toBe("4011223344");
  });
});

describe("pacing configuration", () => {
  it("reads the delay and cap from the env module, not process.env directly", () => {
    vi.stubEnv("LINKEDIN_ENRICH_DELAY_MS", "250");
    vi.stubEnv("LINKEDIN_ENRICH_DAILY_CAP", "5");
    vi.stubEnv("ENABLE_LINKEDIN_ENRICH", "0");
    resetEnvCache();

    // getEnv() coerces, so these are real numbers/booleans, not strings.
    expect(enrichDelayMs()).toBe(250);
    expect(enrichSettings()).toEqual({
      enabled: false,
      dailyCap: 5,
      delayMs: 250,
    });
  });

  it("falls back to the configured defaults when nothing is set", () => {
    resetEnvCache();
    expect(enrichSettings()).toEqual({
      enabled: true,
      dailyCap: 80,
      delayMs: 1500,
    });
  });
});

describe("sleep", () => {
  it("resolves after the requested delay and tolerates 0 or negative input", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const pending = sleep(1500).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await expect(sleep(-5)).resolves.toBeUndefined();
  });
});
