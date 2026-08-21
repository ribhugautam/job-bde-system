import { NextRequest, NextResponse } from "next/server";
import { saveResume, MAX_RESUME_BYTES } from "@/lib/infra/db/documents";
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
    filename: file.name || "resume.pdf",
    mimeType: file.type || "application/pdf",
    bytes,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
