import { NextRequest, NextResponse } from "next/server";
import { saveResume, MAX_RESUME_BYTES } from "@/lib/infra/db/documents";
import { extractPdfText } from "@/lib/infra/pdf/text";
import { extractProfile } from "@/lib/domain/scoring/extract";
import { saveExtractedProfile } from "@/lib/infra/db/profiles";
import { getApiActor } from "@/lib/infra/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // proxy.ts proves only that the cookie is genuine; it cannot reach the
  // database, so it cannot tell whether the account behind it still exists
  // or is still active. Without this check a deactivated colleague keeps
  // full use of this route until their cookie expires -- up to 30 days.
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ ok: false, error: actor.error }, { status: actor.status });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected a multipart/form-data upload." },
      { status: 400 }
    );
  }

  const file = form.get("resume");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { ok: false, error: "No file received under the field name 'resume'." },
      { status: 400 }
    );
  }

  // Check the declared size before buffering, so an oversized upload can't be
  // pulled fully into memory on a serverless function first.
  if (file.size > MAX_RESUME_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `File is ${(file.size / 1024 / 1024).toFixed(2)}MB; the limit is ${
          MAX_RESUME_BYTES / 1024 / 1024
        }MB.`,
      },
      { status: 413 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await saveResume({
    userId: actor.user.id,
    filename: file.name || "resume.pdf",
    mimeType: file.type || "application/pdf",
    bytes,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }

  // ---------------------------------------------------------------------
  // Derive a scoring profile from the CV that was just stored.
  //
  // Ordered deliberately AFTER the save, and never allowed to fail the
  // request. Storing the file is the part that matters -- applications
  // attach it -- while the profile is a convenience the user can write by
  // hand on /dashboard/profile. Losing an upload because a PDF would not
  // parse would be much the worse outcome, so every failure here degrades to
  // "extracted: false" and the upload still succeeds.
  // ---------------------------------------------------------------------
  let extracted = false;
  let extractionNote: string | undefined;

  const text = await extractPdfText(bytes);
  if (!text.ok) {
    extractionNote =
      "Saved, but the text could not be read out of this PDF (it may be a " +
      "scan). Set your skills by hand on the Profile page.";
  } else {
    const { profile, found } = extractProfile(text.text);
    if (found.lowConfidence) {
      extractionNote =
        "Saved, but almost no text came out of this PDF -- it is probably an " +
        "image-only scan. Set your skills by hand on the Profile page.";
    } else {
      // Never overwrites a profile the user has edited by hand: extraction is
      // a guess, an edit is an instruction.
      const applied = await saveExtractedProfile(actor.user.id, profile, result.id);
      extracted = applied.applied;
      extractionNote = applied.applied
        ? `Found ${found.skills.length} skills. Check them on the Profile page.`
        : "Saved. Your profile was left alone because you have edited it by hand.";
    }
  }

  return NextResponse.json({ ...result, extracted, extractionNote });
}
