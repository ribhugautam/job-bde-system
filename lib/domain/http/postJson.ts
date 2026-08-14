// ---------------------------------------------------------------------------
// POST JSON without ever throwing at the caller.
//
// Every caller of this is a button that flips a busy flag on, awaits, and flips
// it off. The bug this exists to kill: the callers used to `await res.json()`
// BEFORE checking `res.ok`, with the reset sitting after the parse. None of the
// action routes has a top-level try/catch, so an uncaught server exception
// answers with a plain-text 500 — the parse rejects, the reset line is never
// reached, and the button latches on "Sending…" forever with nothing on screen
// to say why. A reload was the only recovery.
//
// So: transport failure, unreadable body and error status all come back as a
// value, and the caller can always reset itself. Pure and framework-free —
// nothing here imports React, Next or the database, which is what makes it
// testable without a component stack.
// ---------------------------------------------------------------------------

export type PostJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** Enough of a non-JSON body to recognise it, without pasting a whole page. */
const SNIPPET_LIMIT = 160;

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "empty response body";
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat;
}

/**
 * The routes answer failures as `{ error: string }`. Anything else — a bare
 * `{}`, an array, a JSON string — has no message worth showing, so the status
 * line is used instead.
 */
function messageFrom(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { error } = parsed as { error?: unknown };
    if (typeof error === "string" && error.trim()) return error;
  }
  return null;
}

export async function postJson(url: string, body: unknown): Promise<PostJsonResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Offline, DNS failure, the deployment restarting mid-click.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Read as text first. `res.json()` on a plain-text 500 or an HTML error page
  // rejects, and that rejection is the whole bug.
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      error: `Could not read the response (HTTP ${res.status}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let parsed: unknown = null;
  let parsedOk = true;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsedOk = false;
    }
  }

  if (!parsedOk) {
    return {
      ok: false,
      error: res.ok
        ? `Server sent a non-JSON response (HTTP ${res.status}): ${snippet(text)}`
        : `Request failed with HTTP ${res.status}: ${snippet(text)}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: messageFrom(parsed) ?? `Request failed with HTTP ${res.status}.`,
    };
  }

  return { ok: true, data: parsed };
}
