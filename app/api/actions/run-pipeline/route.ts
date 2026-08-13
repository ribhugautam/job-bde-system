import { NextResponse } from "next/server";
import { runWorker } from "@/lib/pipeline/worker";
import { getEnvSafe } from "@/lib/config/env";

export const dynamic = "force-dynamic";
// Matches /api/cron/daily. The worker stops itself on WORKER_TIME_BUDGET_MS
// (45s by default) rather than being killed here, so a long run ends cleanly
// with work still queued instead of dying mid-write.
export const maxDuration = 60;

/**
 * Runs the pipeline on demand from the dashboard.
 *
 * Authorization is the session cookie, enforced by proxy.ts — this path is
 * under /api/ and is NOT in the public allowlist there, so an unauthenticated
 * caller gets a 401 before reaching this code.
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
