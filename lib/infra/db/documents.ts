import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "./client";

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
 * Returns a user's active resume, or null if they have not uploaded one.
 * Callers that MUST have a resume should use requireActiveResume() instead.
 *
 * SCOPED TO ONE USER, with no fallback to "any active resume". That fallback
 * would be the single worst bug this system could have: it would attach one
 * person's CV to another person's application, under that person's name, to a
 * real company. A missing resume must read as missing.
 */
export async function getActiveResume(userId: number): Promise<ResumeFile | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.userId, userId),
        eq(schema.documents.kind, "resume"),
        eq(schema.documents.isActive, true)
      )
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
export async function requireActiveResume(userId: number): Promise<ResumeFile> {
  const resume = await getActiveResume(userId);
  if (!resume) {
    throw new Error(
      "No active resume on file for this user. Upload a PDF at /dashboard/resume " +
        "before any application can be sent."
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
  userId: number;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<SaveResumeResult> {
  const { userId, filename, mimeType, bytes } = opts;

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
  // Scoped to this user. Unscoped, one person uploading a CV would deactivate
  // everyone else's and silently stop their applications being sent with one.
  await db
    .update(schema.documents)
    .set({ isActive: false })
    .where(
      and(
        eq(schema.documents.userId, userId),
        eq(schema.documents.kind, "resume"),
        eq(schema.documents.isActive, true)
      )
    );

  const [inserted] = await db
    .insert(schema.documents)
    .values({
      userId,
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
