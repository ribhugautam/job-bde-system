import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import { saveSettings } from "@/lib/infra/db/settings";

export const dynamic = "force-dynamic";

/**
 * Saves the deployment's runtime settings. Admin only.
 *
 * These decide what the shared pipeline does for EVERYONE — how jobs are
 * scored, which sources run, how much mail goes out — so unlike a profile or a
 * mailbox this is not a per-user preference and is gated accordingly.
 *
 * Note the one thing this route cannot do: turn sending on when `DRY_RUN=1` is
 * set in the environment. The effective value is `env || settings` (see
 * effectiveDryRun), so a deploy-level stop survives anything submitted here.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor({ admin: true });
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const result = await saveSettings(body, actor.user.id);
  if (!result.ok) {
    // Cross-field problems, phrased for a person looking at a form rather than
    // a startup log. These were a boot crash when they lived in env.
    return NextResponse.json({ error: result.errors.join(" ") }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
