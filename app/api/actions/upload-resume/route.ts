import { NextRequest, NextResponse } from "next/server";
import { saveResume, MAX_RESUME_BYTES } from "@/lib/infra/db/documents";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
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
