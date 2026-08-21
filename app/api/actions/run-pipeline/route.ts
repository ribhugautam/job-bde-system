import { NextResponse } from "next/server";
import { runWorker } from "@/lib/pipeline/worker";
import { getEnvSafe } from "@/lib/config/env";
import { getApiActor } from "@/lib/infra/session";

export const dynamic = "force-dynamic";
// Matches /api/cron/daily. The worker stops itself on WORKER_TIME_BUDGET_MS
// (45s by default) rather than being killed here, so a long run ends cleanly
// with work still queued instead of dying mid-write.
export const maxDuration = 60;

/**
 * Runs the pipeline on demand from the dashboard.
 *
 * Authorization is in two layers. proxy.ts rejects an unauthenticated caller
 * before this code runs — this path is under /api/ and is NOT in the public
 * allowlist there. But the Edge gate cannot reach the database, so it cannot
 * tell a live account from a deactivated one; getApiActor() below is what
 * actually decides whether this caller may still run the pipeline.
 *
 * Deliberately a separate route from /api/cron/daily rather than the button
 * calling that one. /api/cron/daily is public (Vercel Cron cannot send a
 * browser cookie) and is protected by CRON_SECRET instead. For the button to
 * use it, the secret would have to be embedded in the page — readable in page
 * source, the JS bundle, and browser cache. Two auth mechanisms for two
 * genuinely different callers is the right shape; leaking the cron credential
 * into the browser to reuse one route is not.
 *
 * POST, not GET: this has side effects — it sends real email — and must never
 * be triggerable by a prefetch, a link, or a page preview.
 */
export async function POST() {
  // proxy.ts proves only that the cookie is genuine; it cannot reach the
  // database, so it cannot tell whether the account behind it still exists
  // or is still active. Without this check a deactivated colleague keeps
  // full use of this route until their cookie expires -- up to 30 days.
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }
  const env = getEnvSafe();
  if (!env.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid environment configuration", issues: env.issues },
      { status: 500 }
    );
  }

  try {
    const result = await runWorker();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
