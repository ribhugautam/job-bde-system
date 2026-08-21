import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import { buildProfile } from "@/lib/domain/scoring/profile";
import { saveProfile } from "@/lib/infra/db/profiles";

export const dynamic = "force-dynamic";

/**
 * Saves the signed-in user's scoring profile.
 *
 * Always writes `autoExtracted: false`. Reaching this route means a human
 * changed something, and that flag is what stops the next resume upload
 * overwriting their work — extraction is a guess, an edit is an instruction.
 *
 * A user can only ever write their OWN profile: the id comes from the session,
 * never from the request body. There is no admin override, because a profile is
 * what somebody's job list is ranked by and nobody else has standing to change
 * that.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // buildProfile is total: it drops anything malformed rather than throwing, so
  // a hand-edited request cannot 500 this route or store a profile that later
  // breaks the job list.
  const profile = buildProfile({
    skills: body.skills,
    targetRoles: body.targetRoles,
    vetoPhrases: body.vetoPhrases,
    careerStart:
      typeof body.careerStart === "string" && body.careerStart.trim()
        ? body.careerStart
        : null,
    acceptedArrangements: body.acceptedArrangements,
  });

  await saveProfile(actor.user.id, profile, { autoExtracted: false });
  return NextResponse.json({ ok: true });
}
