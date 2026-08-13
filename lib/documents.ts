import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";

// ATS resume size limits are tight — SmartRecruiters caps attachments at 2MB,
// and several others sit around 5MB. We cap the DECODED file at 2MB so the
// stored base64 (~2.7MB) stays well inside a comfortable SQLite row, and so a
// resume that uploads fine here can't be rejected downstream for size.
export const MAX_RESUME_BYTES = 2 * 1024 * 1024;
export const ALLOWED_RESUME_MIME = ["application/pdf"] as const;

export type ResumeFile = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  uploadedAt: Date | null;
};

/**
 * Returns the active resume, or null if none has been uploaded yet.
 * Callers that MUST have a resume should use requireActiveResume() instead.
 */
export async function getActiveResume(): Promise<ResumeFile | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.documents)
    .where(
      and(eq(schema.documents.kind, "resume"), eq(schema.documents.isActive, true))
    )
    .orderBy(desc(schema.documents.uploadedAt))
    .limit(1);

  if (!row) return null;
  return {
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    buffer: Buffer.from(row.contentBase64, "base64"),
    uploadedAt: row.uploadedAt,
  };
}

/**
 * Hard guard for any code path that submits an application. An application
 * with no CV attached is worse than no application at all - it reads as
 * careless and burns the lead. Fail loudly instead.
 */
export async function requireActiveResume(): Promise<ResumeFile> {
  const resume = await getActiveResume();
  if (!resume) {
    throw new Error(
      "No active resume on file. Upload a PDF at /dashboard/settings (or run " +
        "`npm run seed:resume -- <path-to.pdf>`) before any application can be sent."
    );
  }
  return resume;
}

export type SaveResumeResult =
  | { ok: true; id: number; sizeBytes: number }
  | { ok: false; error: string };

/**
 * Stores a new resume and deactivates any previous one, so getActiveResume()
 * always has exactly one answer. Old rows are kept, not deleted, so you can see
 * which version of the CV was on file when a given application went out.
 */
export async function saveResume(opts: {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<SaveResumeResult> {
  const { filename, mimeType, bytes } = opts;

  if (!ALLOWED_RESUME_MIME.includes(mimeType as (typeof ALLOWED_RESUME_MIME)[number])) {
    return {
      ok: false,
      error: `Unsupported file type "${mimeType}". Upload a PDF - it's the only format every ATS parses reliably.`,
    };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "File is empty." };
  }
  if (bytes.length > MAX_RESUME_BYTES) {
    return {
      ok: false,
      error: `File is ${(bytes.length / 1024 / 1024).toFixed(2)}MB; the limit is ${
        MAX_RESUME_BYTES / 1024 / 1024
      }MB (several ATS platforms reject anything larger).`,
    };
  }
  // Cheap sanity check that this is really a PDF and not something renamed.
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return {
      ok: false,
      error: "That file isn't a valid PDF (missing the %PDF- header).",
    };
  }

  const db = getDb();
  await db
    .update(schema.documents)
    .set({ isActive: false })
    .where(
      and(eq(schema.documents.kind, "resume"), eq(schema.documents.isActive, true))
    );

  const [inserted] = await db
    .insert(schema.documents)
    .values({
      kind: "resume",
      filename,
      mimeType,
      sizeBytes: bytes.length,
      contentBase64: bytes.toString("base64"),
      isActive: true,
    })
    .returning();

  return { ok: true, id: inserted.id, sizeBytes: bytes.length };
}
