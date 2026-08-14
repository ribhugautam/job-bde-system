import { describe, it, expect, vi, afterEach } from "vitest";
import { postJson } from "@/lib/domain/http/postJson";

// The failure this module exists to prevent: a button that awaits
// `res.json()` before checking `res.ok`, resets its busy flag after the parse,
// and therefore latches disabled forever the moment a route answers with
// anything that is not JSON.

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return impl(String(url), init);
    })
  );
  return calls;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("postJson", () => {
  it("returns the parsed body on success", async () => {
    stubFetch(() => json({ ok: true, id: 7 }));
    const res = await postJson("/api/actions/update-status", { id: 7 });
    expect(res).toEqual({ ok: true, data: { ok: true, id: 7 } });
  });

  it("sends a JSON POST with the body it was given", async () => {
    const calls = stubFetch(() => json({ ok: true }));
    await postJson("/api/actions/update-status", { entity: "job", id: 3, status: "ignored" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/actions/update-status");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      entity: "job",
      id: 3,
      status: "ignored",
    });
  });

  it("surfaces the route's own error message from a JSON error body", async () => {
    stubFetch(() => json({ error: "status must be one of: found, matched" }, 400));
    const res = await postJson("/api/actions/update-status", {});
    expect(res).toEqual({ ok: false, error: "status must be one of: found, matched" });
  });

  it("falls back to the status line when the JSON error body carries no message", async () => {
    stubFetch(() => json({ ok: false }, 500));
    const res = await postJson("/api/actions/send-application", {});
    expect(res).toEqual({ ok: false, error: "Request failed with HTTP 500." });
  });

  // The actual bug. None of the action routes has a top-level try/catch, so an
  // uncaught server exception answers with a plain-text 500. `res.json()` on
  // that rejects; this must return a value instead.
  it("does not throw on a non-JSON error body, and says what came back", async () => {
    stubFetch(
      () =>
        new Response("Internal Server Error: TypeError: Cannot read properties of undefined", {
          status: 500,
          headers: { "content-type": "text/plain" },
        })
    );
    const res = await postJson("/api/actions/send-outreach", { outreachId: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("HTTP 500");
    expect(res.error).toContain("TypeError");
  });

  it("collapses and truncates a long HTML error page rather than dumping it", async () => {
    const html = `<html>\n  <body>${"error ".repeat(200)}</body>\n</html>`;
    stubFetch(() => new Response(html, { status: 502 }));
    const res = await postJson("/api/actions/send-application", {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("HTTP 502");
    expect(res.error.length).toBeLessThan(240);
    expect(res.error).not.toContain("\n");
  });

  it("reports an empty error body as empty rather than as silence", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const res = await postJson("/api/actions/update-status", {});
    expect(res).toEqual({ ok: false, error: "Request failed with HTTP 503." });
  });

  it("returns the rejection message when the network fails outright", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const res = await postJson("/api/actions/update-status", {});
    expect(res).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("treats a 200 with an unparseable body as a failure, not as success", async () => {
    stubFetch(() => new Response("<!doctype html><p>not json", { status: 200 }));
    const res = await postJson("/api/actions/update-status", {});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("non-JSON");
  });

  it("accepts an empty 200 body as success with no data", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    const res = await postJson("/api/actions/update-status", {});
    expect(res).toEqual({ ok: true, data: null });
  });
});
