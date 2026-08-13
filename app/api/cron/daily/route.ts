import { NextRequest, NextResponse } from "next/server";
import { runWorker } from "@/lib/pipeline/worker";
import { getEnvSafe } from "@/lib/config/env";

export const dynamic = "force-dynamic";
// Must stay comfortably above WORKER_TIME_BUDGET_MS (default 45s) so the worker
// stops itself on its own budget rather than being killed mid-write by the
// platform. Vercel Hobby caps this at 60s; on Pro it can go higher, in which
// case raise WORKER_TIME_BUDGET_MS to match or the extra ceiling does nothing.
export const maxDuration = 60;

function isAuthorized(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false; // fail closed - never run unprotected
  // Vercel Cron automatically sends this header when CRON_SECRET is set.
  // Header only - a ?secret= query param would land in Vercel's request logs
  // in plaintext. To trigger manually:
  //   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/daily
  const header = req.headers.get("authorization");
  if (!header) return false;

  // Length-independent comparison is not worth the ceremony here (the secret is
  // high-entropy and this route is not a timing oracle worth building), but an
  // exact match is, so a prefix like "Bearer x" can never pass.
  return header === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  // getEnvSafe, not getEnv: a misconfigured deployment should answer with the
  // specific list of bad keys, not an unhandled 500 whose cause is only visible
  // in the platform logs.
  const env = getEnvSafe();
  if (!env.ok) {
    // Authorize first even on a bad config, so the issue list is not readable
    // by an unauthenticated caller — it names internal configuration.
    if (!isAuthorized(req, process.env.CRON_SECRET)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { ok: false, error: "invalid environment configuration", issues: env.issues },
      { status: 500 }
    );
  }

  if (!isAuthorized(req, env.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
