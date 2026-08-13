import { NextRequest, NextResponse } from "next/server";
import { runDailyPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // seconds - Vercel Cron functions default to 10s on Hobby unless configured

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed - never run unprotected
  // Vercel Cron automatically sends this header when CRON_SECRET is set.
  // Header only - a ?secret= query param would land in Vercel's request logs
  // in plaintext. To trigger manually:
  //   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/daily
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDailyPipeline();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
